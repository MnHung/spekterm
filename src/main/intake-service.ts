import { digestOf, IntakeStore, MAX_PENDING, type IntakeNotice, type IntakeRecord } from './intake-store'
import { isValidIntakeId } from './intake-id'
import { isPermanentRejection } from './intake-rejection'
import { normalizeAuthored, parseIntake, type DeliveryProvenance, type IntakeRejection } from './intake-schema'
import { saveDelivery } from './intake-archive'

/**
 * 投遞的唯一入口。
 *
 * ## 為什麼是一個函式，而檔案只是它的 adapter
 *
 * 第一個 producer（Slack adapter）住在主行程裡，而**它仍然寫檔給自己讀** —— 那個繞路是
 * 裁決過的（`slack-mention-intake` 的 design D5），理由不是「介面的整潔」：
 *
 * - 走檔案多拿到的是**投遞檔的大小上限**與**拒絕的消費語意**（暫時性拒絕原封留著等重試）。
 *   其餘守衛（正規化、識別碼驗證、重複、總量上限）都在 `deliver()` 之內，行程內捷徑一樣拿得到。
 * - **真正承重的理由**：Socket Mode 的 app 上不了 Slack Marketplace，所以那一層**必然會被換掉**
 *   （產品化要走 Events API + 公開端點）。adapter 日後要搬到另一個行程，而那時這個檔案
 *   一個字都不必改。
 *
 * 外部 producer（`spek handoff` CLI、日後的 relay）是獨立行程，因此檔案介面本來就必須存在；
 * 而它也讓這個能力得以在沒有任何來源的情況下被完整驗收。
 *
 * **驗證、去重、落盤全部在 `deliver()` 之後**，於是「啟動掃描」與「監看」不可能演化成
 * 兩份寬嚴不同的實作 —— 那是這條管線最容易出現、而且完全靜默的 bug（第二份較弱的實作）。
 *
 * ## 拒絕分永久性與暫時性，而分界是「這次拒絕可不可逆」
 *
 * - **永久性**（識別碼不合法、超長、型別不合、內容相同的重複、內容不同的重複）—— 投遞檔被
 *   消費掉。留著的話，每次啟動都會把歷來每一次拒絕重新處理、重新呈現一遍。
 * - **暫時性**（達到待處理總量上限）—— 投遞檔**原封留在落點**，等上限解除後再處理。
 *   刪掉它就是把一件只是「現在太多了」的真實工作項目銷毀。
 * - **解析失敗**（`JSON.parse` 不過）—— 也是原封留著，因為它可能只是**寫到一半**。
 *   這一類與「確定損毀」在讀取當下不可分辨，分辨它需要穩定窗口或跨啟動計數；
 *   本 change 接受「永久損毀的檔案每次啟動被重讀一次」這個成本（見 design 的缺口表）。
 *
 * ## 內容相同的重複要靜默
 *
 * `deliver()` 自己就會製造內容相同的重複：檔案 adapter 刻意「先建立監看、再掃描落點」，
 * 於是中間抵達的檔案被處理兩次。**把它做成可見的拒絕，等於每次啟動都對使用者報告一件他沒
 * 做過的事**，而那個通道正是識別碼搶佔唯一的警訊 —— 讓噪音與警訊走同一條路，等於把警訊關掉。
 */

/** 投遞的結果。`consume` 告訴 adapter 該不該把投遞檔收掉。 */
export interface DeliverOutcome {
  ok: boolean
  code?: IntakeRejection
  /** 是否應消費掉來源項目（永久性處置為真）。 */
  consume: boolean
  /** 是否要讓使用者看到。內容相同的重複恆為 false。 */
  notify: boolean
  detail?: string
  record?: IntakeRecord
  /**
   * 這次拒絕的診斷欄位 —— **由 adapter 填入**。
   *
   * 共用的攝入路徑算不出它們：`deliver()` 只拿得到 `provenance`（來源座標與**已解析的**
   * 目標 folder），而「投遞者當初寫的是哪個字串」正是診斷一次「查無」時唯一有用的東西。
   *
   * **不讓共用路徑自己去讀 `raw.target`** —— 那會破壞「payload 自稱的一律不採信」的姿態。
   */
  failure?: FailureContext
}

/** 一次失敗的診斷欄位。全部 optional：不是每個 adapter 都算得出它們。 */
export interface FailureContext {
  /** 投遞者寫下的目標原字串。**第三方可控，進入痕跡時要正規化。** */
  target?: string
  /** 來源座標的標籤（folder 名稱／`Global`／已結束）。 */
  origin?: string
  /**
   * What failed, when a code alone cannot say: `FIELD_TYPE` and `TOO_LONG` are shared by handoffs and session
   * commands (`agent-session-control` D6). Only the notification reads it; it is not persisted with the trace.
   */
  subject?: 'command'
}

/** 一次**永久性**失敗 —— 由 adapter 經 `reportFailure()` 送出，供通知與痕跡消費。 */
export interface IntakeFailure extends FailureContext {
  code: IntakeRejection
  detail?: string
  at: number
}

/**
 * 面向使用者的拒絕與警示 —— **有界**。
 *
 * 同一主鍵的重複拒絕合併為一則並累加次數；總則數設上限。投遞者控制投遞的數量，
 * 而使用者的注意力是這條管線僅有的兩道人類防線之一（另一道是讀本文）。
 */

/**
 * 面向使用者的拒絕呈現，其總則數上界。
 *
 * **額度以 adapter 分配**（見 `#notice`）：痕跡由所有 producer 共用，而第三方來源的格式錯誤
 * 可以是高頻的 —— 交接的失敗被擠進溢位之後，「交接的失敗對使用者可見」在真實使用中就失效了。
 */
export type { IntakeNotice } from './intake-store'

const MAX_NOTICES = 20

/** 單一 adapter 至多佔用的則數。留下的空間讓其他來源仍進得來。 */
const MAX_NOTICES_PER_ADAPTER = 12

/**
 * 溢位桶的主鍵。
 *
 * **它不是一個給人看的字串** —— 呈現層要認得它並換成一句可翻譯的說明。
 * 此前它是字面的 `'…'` 而且從未被渲染（拒絕只呈現為一個總數），落盤＋逐則呈現之後
 * 它會直接變成畫面上的一個字。
 */
export const OVERFLOW_KEY = '\u0000overflow'

/** 記一次拒絕時，由 adapter 提供的脈絡。 */
export interface NoticeContext extends FailureContext {
  adapter?: string
  /** 見 `DeliverOutcome.notify` —— `DUPLICATE` 的兩種行為靠它分辨。 */
  notify?: boolean
}

export interface IntakeServiceOptions {
  store: IntakeStore
  /** 原始投遞的保存處。 */
  archiveRoot: string
  /** 待處理則數上限。**可注入** —— 驗收要造出「達到上限」這個前提，真實值造不起。 */
  maxPending?: number
}

export class IntakeService {
  readonly #store: IntakeStore
  readonly #archiveRoot: string
  readonly #maxPending: number
  #notices: IntakeNotice[] = []
  readonly #failures = new Set<(failure: IntakeFailure) => void>()
  #listeners = new Set<() => void>()
  #arrivals = new Set<(record: IntakeRecord) => void>()

  constructor({ store, archiveRoot, maxPending = MAX_PENDING }: IntakeServiceOptions) {
    this.#store = store
    this.#archiveRoot = archiveRoot
    this.#maxPending = maxPending
    // **痕跡跨重啟**。少了這一行，一則失敗的可見性取決於使用者在關掉應用程式之前剛好打開過
    // 收件匣 —— 而促使他去打開收件匣的那個訊號（通知）正是同一條路徑上的東西。
    this.#notices = store.notices()
  }

  get store(): IntakeStore {
    return this.#store
  }

  notices(): IntakeNotice[] {
    return this.#notices.map((n) => ({ ...n }))
  }

  /** 清除全部痕跡。 */
  clearNotices(): void {
    this.#notices = []
    this.#persistNotices()
    this.#emit()
  }

  /**
   * 清除**一則**痕跡。
   *
   * 一次清光全部會讓使用者為了清掉一則第三方投遞的格式錯誤，順手清掉一則他還沒處理的
   * 交接失敗 —— 而後者正是這條通道存在的理由。
   */
  dismissNotice(key: string, code: string): void {
    this.#notices = this.#notices.filter((n) => !(n.key === key && n.code === code))
    this.#persistNotices()
    this.#emit()
  }

  #persistNotices(): void {
    this.#store.setNotices(this.#notices)
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }

  /**
   * 訂閱**到達** —— 「一則新的 intake 進來了，它是哪一則」。
   *
   * ## 為什麼不能沿用既有的兩個
   *
   * `subscribe()` 的語意是「有東西變了」（不帶參數，收件匣靠它重新拉取），它對「拒絕」
   * 與「到達」一視同仁。而 `DeliverOutcome.notify` 的語意**與這裡所需恰好相反** ——
   * 它是「這則**拒絕**要不要讓使用者看到」，成功路徑上恆為 `false`。
   * 照字面接上去，結果會是：每一次拒絕跳一則桌面通知、每一則真正進來的都不跳。
   *
   * ## 為什麼在這裡而不是讓呼叫端自己判斷
   *
   * `deliver()` 是投遞的唯一入口，兩個 producer 都走它。讓每個呼叫端自己看 `outcome.ok`
   * 再決定，就是把同一個判斷複製成兩份 —— 本檔檔頭正是在警告這件事（兩條路會演化成兩份
   * 寬嚴不同的實作，而那是完全靜默的）。
   */
  onArrival(listener: (record: IntakeRecord) => void): () => void {
    this.#arrivals.add(listener)
    return () => this.#arrivals.delete(listener)
  }

  #emitArrival(record: IntakeRecord): void {
    for (const listener of this.#arrivals) listener(record)
  }

  /**
   * 訂閱**永久性失敗** —— 「一件事確定做不成了，而且重送也不會不同」。
   *
   * ## 為什麼不是 `DeliverOutcome.notify`
   *
   * 那個旗標的語意是「這則拒絕要不要讓使用者在收件匣裡看到」，它對**暫時性**的拒絕
   * 同樣為真（寫到一半、收件匣已滿）。接在它上面，一份還沒寫完的投遞會在每次補寫時
   * 各跳一則桌面通知 —— 逐次通知沒有上界。
   *
   * ## 為什麼由 adapter 送出而不是在這裡判
   *
   * 「被拒絕的投遞 SHALL NOT 發出作業系統通知」是共用路徑的規則，交接是它**明文的例外**。
   * 判斷「這個 adapter 適不適用那條例外」的知識在 adapter 那一側 —— 在這裡判就要硬編
   * adapter 的名字，而那會讓例外變成常規的一部分。
   */
  onFailure(listener: (failure: IntakeFailure) => void): () => void {
    this.#failures.add(listener)
    return () => this.#failures.delete(listener)
  }

  /**
   * 回報一次永久性失敗。**由 adapter 呼叫** —— 它才知道自己適不適用那條例外。
   *
   * 呈現（`#notices`）已經在拒絕發生的當下記過一筆；這裡只負責「讓使用者現在就知道」。
   */
  /** Whether one more delivery would fit under the pending limit (the `CAPACITY` rejection). */
  hasRoom(): boolean {
    return this.#store.pendingCount() < this.#maxPending
  }

  reportFailure(failure: IntakeFailure): void {
    for (const listener of this.#failures) listener(failure)
  }

  /**
   * 記下一次拒絕，**供收件匣逐則呈現**。
   *
   * ## 合併保留最近一次的時刻
   *
   * 使用者要知道的是「這件事還在發生嗎」，而一個停在三天前的時刻對那個問題完全沉默。
   *
   * ## 額度以 adapter 分配
   *
   * 痕跡由所有 producer 共用。第三方來源的格式錯誤可以是高頻的，而交接的失敗被擠進溢位桶
   * 之後，「交接的失敗對使用者可見」在真實使用中就失效了 —— 它會是一個沒有任何東西會變紅
   * 的失效。
   */
  #notice(code: IntakeRejection, key: string, detail?: string, context?: NoticeContext): void {
    const at = Date.now()
    const existing = this.#notices.find((n) => n.key === key && n.code === code)
    if (existing) {
      existing.count += 1
      existing.at = at
      this.#persistNotices()
      return
    }

    const adapter = context?.adapter
    const sameAdapter = this.#notices.filter((n) => n.adapter === adapter && n.key !== OVERFLOW_KEY)
    const full = this.#notices.length >= MAX_NOTICES
    const overQuota = adapter !== undefined && sameAdapter.length >= MAX_NOTICES_PER_ADAPTER
    if (full || overQuota) {
      // 已達上限：合併成一則「其餘」而非無限累積。
      const overflow = this.#notices.find((n) => n.key === OVERFLOW_KEY)
      if (overflow) {
        overflow.count += 1
        overflow.at = at
      } else {
        this.#notices.push({ key: OVERFLOW_KEY, code, count: 1, at, permanent: false })
      }
      this.#persistNotices()
      return
    }

    this.#notices.push({
      key,
      code,
      count: 1,
      at,
      permanent: isPermanentRejection({ code, notify: context?.notify ?? true }),
      ...(detail ? { detail } : {}),
      ...(adapter === undefined ? {} : { adapter }),
      // **第三方可控的兩個欄位在這裡正規化** —— 與 authored 欄位同一套白名單、同一個位置。
      // 它們從此會被渲染、被落盤，而正規化只在攝入發生一次。
      ...(context?.origin === undefined ? {} : { origin: normalizeAuthored(context.origin) }),
      ...(context?.target === undefined ? {} : { target: normalizeAuthored(context.target) }),
    })
    this.#persistNotices()
  }

  /**
   * 超出大小上限的投遞 —— **由 adapter 判定**（它才看得到檔案），但拒絕的呈現仍走這裡，
   * 於是「拒絕必須可見」只有一個實作，而它的合併與上限也只有一份。
   */
  /**
   * 一次由 adapter 判定的拒絕，走**共用的**彙整呈現。
   *
   * 與 `rejectOversize` 同一個姿態：判定發生在 adapter（只有它算得出「目標查無」），
   * 但**呈現不另開一條路** —— 否則「面向使用者的拒絕與警示 SHALL 有界」會被繞過。
   */
  reject(code: IntakeRejection, label: string, detail?: string, context?: NoticeContext): DeliverOutcome {
    this.#notice(code, label, detail, context)
    this.#emit()
    return { ok: false, code, consume: true, notify: true, detail }
  }

  rejectOversize(label: string, context?: NoticeContext): DeliverOutcome {
    this.#notice('TOO_LARGE', label, undefined, context)
    this.#emit()
    return { ok: false, code: 'TOO_LARGE', consume: true, notify: true }
  }

  /**
   * 收下一份投遞。
   *
   * `contents` 是**原始的 JSON 文字**（保存用），`adapter` 由接收端決定 —— payload 自稱的
   * 來源一律不採信，檔案落點中的 `source` / `origin` 是自稱，不是 provenance。
   *
   * `provenance` 是**接收端算得出來、投遞內容表達不出來**的那些值（交接的來源與已解析的目標）。
   * 它與 `adapter` 同一個姿態：**是參數，不是欄位**。做成欄位的話，任何放進共用投遞落點的
   * 檔案都能繞過 routing 自選 folder。
   */
  async deliver(
    contents: string,
    adapter: string,
    provenance?: DeliveryProvenance,
    /**
     * 這次投遞若失敗，痕跡要記下的診斷欄位 —— **由 adapter 供應**。
     *
     * 共用路徑算不出它們（見 `FailureContext`），而本 change 的起因（`TOO_LONG`）正好就
     * 發生在共用路徑上 —— 少了這個參數，那一則痕跡說不出「是哪一件事」。
     */
    failure?: FailureContext,
  ): Promise<DeliverOutcome> {
    let raw: unknown
    try {
      raw = JSON.parse(contents)
    } catch {
      // **不消費** —— 可能只是寫到一半。
      return { ok: false, code: 'MALFORMED', consume: false, notify: false }
    }

    const parsed = parseIntake(raw, adapter, provenance)
    if (!parsed.ok) {
      this.#notice(
        parsed.code,
        typeof (raw as { id?: unknown })?.id === 'string' ? String((raw as { id: string }).id) : '(unknown)',
        parsed.detail,
        { adapter, ...failure },
      )
      this.#emit()
      return { ok: false, code: parsed.code, consume: true, notify: true, detail: parsed.detail }
    }

    const intake = parsed.value
    if (!isValidIntakeId(intake.id)) {
      this.#notice('INVALID_ID', '(invalid)', undefined, { adapter, ...failure })
      this.#emit()
      return { ok: false, code: 'INVALID_ID', consume: true, notify: true }
    }

    const existing = this.#store.get(adapter, intake.id)
    if (existing) {
      const digest = digestOf(intake.authored, intake.verified)
      if (digest === existing.digest) {
        // **內容相同 ⇒ 靜默。** 正常的重送與我們自己的雙重讀取都落在這裡。
        return { ok: false, code: 'DUPLICATE', consume: true, notify: false }
      }
      // **內容不同 ⇒ 可見。** 那才是識別碼搶佔，而使用者必須有機會知道有一件事沒進來。
      this.#notice('DUPLICATE', intake.id, undefined, { adapter, ...failure, notify: true })
      this.#emit()
      return { ok: false, code: 'DUPLICATE', consume: true, notify: true }
    }

    if (this.#store.pendingCount() >= this.#maxPending) {
      // **暫時性拒絕 ⇒ 不消費。** 使用者清一清收件匣，這一則本來就該進來。
      this.#notice('CAPACITY', intake.id, undefined, { adapter, ...failure })
      this.#emit()
      return { ok: false, code: 'CAPACITY', consume: false, notify: true }
    }

    await saveDelivery(this.#archiveRoot, intake.id, contents)

    // **重複檢查與記錄之間隔著一個 await —— 這裡要再檢查一次。**
    //
    // 檔案 adapter 刻意做「先建立監看、再掃描落點」的雙重讀取，於是同一份投遞的兩次
    // `deliver()` 可以**都**通過上面那個 `existing` 檢查，然後各自往下走。`store.add` 以
    // 主鍵覆寫，所以收件匣裡仍然只有一筆 —— 但**到達會發出兩次**，而那是使用者看得到的：
    // 計數說 10、合併的通知說 11。（是探針抓到的，單元測試的兩次 deliver 是循序的。）
    const raced = this.#store.get(adapter, intake.id)
    if (raced) {
      // 與上面那段同樣的分流：**同內容靜默、不同內容可見**。只擋同內容是不夠的 ——
      // 一次識別碼搶佔賽進來時，後到的那一份會覆寫紀錄並**再發一次到達**，
      // 於是計數說 N、合併的通知說 N+1（就是這麼被抓到的）。
      if (raced.digest === digestOf(intake.authored, intake.verified)) {
        return { ok: false, code: 'DUPLICATE', consume: true, notify: false }
      }
      this.#notice('DUPLICATE', intake.id, undefined, { adapter, ...failure, notify: true })
      this.#emit()
      return { ok: false, code: 'DUPLICATE', consume: true, notify: true }
    }

    const record = this.#store.add(intake)
    this.#emit()
    // **到達 —— 唯一的發出點。** 它在成功新增紀錄之後，因此六條非成功的返回路徑
    // （上面每一個 early return）都不會走到這裡。
    this.#emitArrival(record)
    return { ok: true, consume: true, notify: false, record }
  }
}
