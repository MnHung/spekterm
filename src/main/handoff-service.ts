import fs from 'node:fs'

import {
  buildDelivery,
  type CommandKind,
  HANDOFF_ADAPTER,
  isCommandKind,
  MAX_REPORT_LENGTH,
  outboxKindOf,
  parseHandoffPayload,
  parseRecurrence,
  parseReport,
  parseScheduledAt,
} from './handoff-delivery'
import { reportIdentity, type ReportDecision } from './handoff-completion'
import { clearOutbox, outboxRoot, receiptsDir, sourceSessionOf } from './handoff-outbox'
import { receiptFor, writeReceipt } from './handoff-receipt'
import { resolveTarget, type TargetCandidate } from './handoff-target'
import type { DeliverOutcome, IntakeService } from './intake-service'
import { sourceTitle, type HandoffSource as LineageSource } from './intake-schema'
import { type FileState, IntakeSource, type IntakeSourceOptions } from './intake-source'
import { isUuid } from './session-store'

/** 來源 session 的座標。`folderId` 為 `null` ＝ 全域 session。 */
export interface HandoffSource {
  folderId: string | null
  label: string
  /** 來源 session 當下的標籤（`customTitle ?? title`）。沒有時缺席。 */
  title?: string
  /** The source's own chain of ancestors now, nearest first (`ancestryOf`). Empty or absent: none. */
  ancestors?: string[]
}

/**
 * 由落點推出的識別碼與它當下的座標，組出要跟著 intake 落盤的來源（`session-lineage`）。
 *
 * **識別碼先驗形狀** —— `sourceSessionOf` 回傳任何目錄名，而這個值之後會被寫進 session、於下次
 * 啟動時被解析。形狀不對時不帶來源（交接照常處理：它只是建不起關係）。
 *
 * 歸屬是三態：查無（已結束）⇒ `unknown`，**不是**全域。
 */
export function lineageSourceOf(sessionId: string, source: HandoffSource | null): LineageSource | undefined {
  if (!isUuid(sessionId)) return undefined
  const title = source?.title ? sourceTitle(source.title) : ''
  // Only ids, so nothing a path could ride on; `parseAncestors` caps and validates them on every read back.
  const ancestors = source?.ancestors?.filter(isUuid) ?? []
  return {
    sessionId,
    origin: !source
      ? { kind: 'unknown' }
      : source.folderId === null
        ? { kind: 'global' }
        : { kind: 'folder', folderId: source.folderId, folderName: source.label },
    ...(title !== '' ? { title } : {}),
    ...(ancestors.length > 0 ? { ancestors } : {}),
  }
}

/** 來源 session 已結束時用的座標識別碼。**不是一個 folder** —— 只是一個座標。 */
export const ENDED_SOURCE_ID = '(ended)'

/** 全域 session 的座標識別碼。 */
export const GLOBAL_SOURCE_ID = '(global)'

export interface HandoffServiceDeps {
  service: IntakeService
  /** 由 sessionId 推出來源。查無（session 已結束）回 `null`。 */
  sourceOf: (sessionId: string) => HandoffSource | null
  /**
   * 查表的定義域。
   *
   * **它與告知 agent 的那份清單必須取自同一個來源** —— 分成兩份的話，agent 手上的選項與接收端
   * 認得的選項會在某一次變動之後分岔，而症狀是「它明明照著清單寫，卻被說查無」。
   */
  candidates: () => TargetCandidate[]
  agentEventsEnabled: () => boolean
  /**
   * A handoff was recorded: let `HandoffOpener` open what is due (`scheduled-handoff`, design D3). **Opening is
   * not done here**: a request no window receives is lost, and the opener is the one owner that waits for a
   * window and opens each handoff at most once.
   */
  onDelivered: () => void
  /**
   * 採納一份完成報告（`handoff-completion`）。未提供 ⇒ 報告一律被當成不認得的種類拒絕。
   * `identity` 讓同一份投遞檔被讀兩次時只採納一次。
   */
  acceptReport?: (sessionId: string, summary: string, identity: string) => ReportDecision
  /**
   * An agent's session command (`agent-session-control`, `SessionControl.deliver`). Unprovided ⇒ the command kinds
   * are refused as an unknown kind is. `mtimeMs` is the file's time as the read saw it.
   */
  control?: (sourceId: string, kind: CommandKind, contents: string, identity: string, mtimeMs: number | undefined) => DeliverOutcome
  /**
   * **Tests only**, passed through to the outboxes' `IntakeSource`: a watcher that reports nothing,
   * and an observer of the periodic re-read. **The interval is deliberately not passed through** —
   * the tests exercise the default production uses.
   */
  sourceTesting?: Pick<IntakeSourceOptions, 'watch' | 'onRescan'>
  /** The clock a delivery is read against. Tests inject it (a real clock broke a test on a slow machine). */
  now?: () => number
}

/**
 * 交接的 producer。
 *
 * **它是收件匣的一個 producer，不是收件匣的一部分** —— 與 `slack-intake-source` 同一個分界：
 * 驗證、去重、context 檔、預填、通知一律沿用。本服務只負責「一則交接如何產生、它的來源與
 * 目標如何被決定」。
 */
export class HandoffService {
  readonly #deps: HandoffServiceDeps
  #source: IntakeSource | null = null

  constructor(deps: HandoffServiceDeps) {
    this.#deps = deps
  }

  async start(): Promise<void> {
    const root = outboxRoot()
    if (!root) return
    this.#source = new IntakeSource({
      root,
      adapter: HANDOFF_ADAPTER,
      service: this.#deps.service,
      // 落點是**每個 session 一層**：`<root>/<sessionId>/*.json`。
      depth: 1,
      deliver: (contents, file, state) => this.deliverFile(contents, file, state),
      /**
       * **這條路徑上的永久性失敗要發通知** —— 「被拒絕的投遞不發通知」那條規則明文的例外。
       *
       * 接受那個環節已經沒有人在看，少了它，一次失敗的交接與「什麼都沒發生」在畫面上完全
       * 相同 —— 而使用者會以為工作已經交出去了。
       */
      notifyFailures: true,
      // Every file read gets a receipt before it is removed (`handoff-receipt`), so the agent can check what
      // became of it instead of assuming.
      onOutcome: (file, outcome) => {
        const sessionId = sourceSessionOf(file)
        if (!sessionId) return
        writeReceipt(receiptsDir(sessionId), receiptFor(file, outcome, Date.now()))
      },
      ...this.#deps.sourceTesting,
    })
    await this.#source.start()
  }

  async dispose(): Promise<void> {
    await this.#source?.dispose()
    this.#source = null
  }

  /**
   * session 結束 —— **先把落點裡既有的項目處理完，再清除**。
   *
   * 少了這個順序，一則已經投遞、尚未被讀到的交接會隨 session 的結束而消失，**而投遞端與
   * 使用者兩邊都不會知道**。
   */
  async endSession(sessionId: string): Promise<void> {
    await this.#source?.scan()
    clearOutbox(sessionId)
  }

  /** 一份投遞檔 → 一次 `deliver()`。 */
  async deliverFile(contents: string, file: string, state?: FileState): Promise<DeliverOutcome> {
    const { service } = this.#deps
    // One reading of the clock per delivery: whether a handoff is scheduled is decided against it, once.
    const now = (this.#deps.now ?? Date.now)()

    const sessionId = sourceSessionOf(file)
    // 不在 `<root>/<sessionId>/` 正下方 ⇒ 不是一份交接。消費掉它，否則它每次掃描都再走一趟。
    if (!sessionId) return { ok: false, code: 'MALFORMED', consume: true, notify: false }

    // **同一個落點，兩種投遞**：沒有種類欄位的是交接（既有格式不變），`kind: "report"` 是完成報告。
    const kind = outboxKindOf(contents)
    if (kind === 'malformed') return { ok: false, code: 'MALFORMED', consume: false, notify: false }
    if (kind === 'unknown') return service.reject('FIELD_TYPE', sessionId, 'kind', { adapter: HANDOFF_ADAPTER })
    if (kind === 'report') return this.#deliverReport(sessionId, contents, file)
    if (isCommandKind(kind)) {
      const control = this.#deps.control
      if (!control) return service.reject('FIELD_TYPE', sessionId, 'kind', { adapter: HANDOFF_ADAPTER })
      // The time comes from the read, never a second `stat` (`agent-session-control` D6).
      const outcome = control(sessionId, kind, contents, reportIdentity(file, state?.mtimeMs, contents), state?.mtimeMs)
      return outcome
    }

    const payload = parseHandoffPayload(contents)
    if (!payload.ok) {
      // **`MALFORMED` 不消費、也不通知** —— 可能只是寫到一半，而那種項目每次補寫都會再被讀到，
      // 逐次通知沒有上界（`agent-intake` 的例外條款明文排除它）。
      if (payload.reason === 'MALFORMED') return { ok: false, code: 'MALFORMED', consume: false, notify: false }
      return service.reject('FIELD_TYPE', sessionId, payload.field ?? 'target / body', { adapter: HANDOFF_ADAPTER })
    }

    const source = this.#deps.sourceOf(sessionId)
    const originId = source ? (source.folderId ?? GLOBAL_SOURCE_ID) : ENDED_SOURCE_ID
    const originLabel = source?.label ?? ENDED_SOURCE_ID

    /**
     * **診斷欄位由這裡交出去** —— 共用的攝入路徑算不出它們。
     *
     * `deliver()` 只拿得到 `provenance`（來源座標與**已解析的**目標 folder），而「投遞者
     * 當初寫的是哪個字串」正是診斷一次「查無」時唯一有用的東西。讓共用路徑自己去讀
     * `raw.target` 則會破壞「payload 自稱的一律不採信」的姿態。
     */
    const failure = { target: payload.value.target, origin: originLabel }

    const schedule = parseScheduledAt(payload.value.at, now)
    if (schedule.kind === 'invalid') {
      return {
        ...service.reject('SCHEDULE_INVALID', payload.value.target, `at: ${schedule.rule}`, { adapter: HANDOFF_ADAPTER, ...failure }),
        failure,
      }
    }
    // With `repeat`, `at` is the recurrence's start and the handoff is a proposal, never a scheduled handoff: the
    // start must not reach `scheduledAt`, which the receipt, the arrival guard and the views all key on.
    const recurrence = parseRecurrence(payload.value, schedule.kind === 'scheduled' ? schedule.at : undefined, now)
    if (recurrence.kind === 'invalid') {
      return {
        ...service.reject('REPEAT_INVALID', payload.value.target, recurrence.rule, { adapter: HANDOFF_ADAPTER, ...failure }),
        failure,
      }
    }

    const target = resolveTarget(payload.value.target, this.#deps.candidates())
    if (!target.ok) {
      return {
        ...(target.reason === 'AMBIGUOUS'
          ? service.reject('TARGET_AMBIGUOUS', payload.value.target, target.candidates.join(', '), {
              adapter: HANDOFF_ADAPTER,
              ...failure,
            })
          : service.reject('TARGET_NOT_FOUND', payload.value.target, undefined, {
              adapter: HANDOFF_ADAPTER,
              ...failure,
            })),
        failure,
      }
    }

    // **預填不可能發生時不建立 session。** 事件回報關閉是一個可事先偵測的**恆定**成因；照樣
    // 建 session 會讓「建了 → 等到逾時 → 退回待處理 → 再處理 → 又建一個」成為主幹。
    if (!this.#deps.agentEventsEnabled()) {
      return {
        ...service.reject('PREFILL_UNAVAILABLE', payload.value.target, undefined, {
          adapter: HANDOFF_ADAPTER,
          ...failure,
        }),
        failure,
      }
    }

    const { contents: delivery, provenance } = buildDelivery({
      sessionId,
      payload: payload.value,
      contents,
      originId,
      originLabel,
      targetFolderId: target.folderId,
      source: lineageSourceOf(sessionId, source),
      ...(recurrence.kind === 'repeating'
        ? { recurrence: recurrence.recurrence }
        : schedule.kind === 'scheduled'
          ? { scheduledAt: schedule.at }
          : {}),
    })

    // **失敗的診斷欄位一律帶上** —— 共用路徑的拒絕（本文過長、識別碼不合法…）同樣要說得出
    // 「是哪一件事」，而它們在那裡算不出目標原字串。
    const outcome = await service.deliver(delivery, HANDOFF_ADAPTER, provenance, failure)
    if (!outcome.ok || !outcome.record) return { ...outcome, failure }

    // **沒有上限**（`handoff-session-lifecycle`，使用者裁決）：每一則合法的交接都到達即建立
    // session 並送出 —— once a window can receive it, and a scheduled one when its time comes (the opener).
    this.#deps.onDelivered()
    return outcome
  }

  /**
   * 完成報告（`handoff-completion`）。**不進收件匣** —— 它不是一件工作交辦，是既有 session 的狀態變化。
   *
   * 拒絕走與交接失敗相同的可見路徑（通知 ＋ 收件匣中的痕跡）；落點所屬的 session 已不存在時**靜默丟棄**
   * —— 例如關閉時 `endSession` 對落點的最後一次掃描，那不是投遞者的錯。
   */
  #deliverReport(sessionId: string, contents: string, file: string): DeliverOutcome {
    const { service } = this.#deps
    const accept = this.#deps.acceptReport
    if (!accept) return service.reject('FIELD_TYPE', sessionId, 'kind', { adapter: HANDOFF_ADAPTER })

    const report = parseReport(contents)
    if (!report.ok) {
      return report.reason === 'TOO_LONG'
        ? service.reject('TOO_LONG', sessionId, `summary ${report.length} > ${MAX_REPORT_LENGTH}`, { adapter: HANDOFF_ADAPTER })
        : service.reject('FIELD_TYPE', sessionId, 'summary', { adapter: HANDOFF_ADAPTER })
    }

    let mtimeMs: number | undefined
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      // 已經被另一次讀取消費掉了 —— 身分退回只用路徑與內容。
    }
    const decision = accept(sessionId, report.summary, reportIdentity(file, mtimeMs, contents))
    if (decision === 'not-handoff') return service.reject('REPORT_NOT_HANDOFF', sessionId, undefined, { adapter: HANDOFF_ADAPTER })
    // A repeated report changes nothing; its receipt says so (`handoff-receipt`).
    return { ok: true, consume: true, notify: false, ...(decision === 'duplicate' ? { duplicate: true } : {}) }
  }
}

/**
 * 目前這個行程的交接服務。
 *
 * **它存在的理由只有一個**：pty 的服務要在 session 結束時通知交接把落點收掉，而它不該認得
 * `HandoffService`（那個「先處理完、再清除」的順序住在這裡，不住在它那裡）。與
 * `configureAgentEvents` / `configureHandoff` 同一個姿態。
 */
let active: HandoffService | null = null

export function registerHandoffService(service: HandoffService | null): void {
  active = service
}

/** session 結束了。尚未註冊時為 no-op（例如偏好關閉、或落點建不起來）。 */
export function endHandoffSession(sessionId: string): void {
  void active?.endSession(sessionId).catch((error) => {
    console.error(`[handoff] failed to end session ${sessionId}: ${String(error)}`)
  })
}
