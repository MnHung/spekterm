import { type WebContents, ipcMain } from 'electron'

import { bodyOf } from '../intake-schema'
import { buildContext, buildPrompt, createNonce, writeContext } from '../intake-context'
import { decideAccept, type IntakeAcceptResult } from '../intake-accept'
import { ticketFor } from '../handoff-ticket'
import { cancelPrefill, prefillModeFor, schedulePrefill, watchSubmission } from '../intake-prefill'
import {
  isAuthoredCriterion,
  type RoutingConfig,
  type RoutingRule,
  type RoutingStore,
} from '../intake-routing'
import { listView, type IntakeView } from '../intake-projection'
import { OVERFLOW_KEY } from '../intake-service'
import type { IntakeService } from '../intake-service'
import type { FolderLookup } from '../workspace-store'
import { existingTerminalService } from './terminal'
import { dismissIntake, notifyIntakeChanged, onIntakeChanged } from '../intake-changes'

/**
 * 收件匣的 IPC。
 *
 * ## renderer 的詞彙不變
 *
 * renderer 拿到的只有 `intakeId`、通用欄位、與一個**已解析好的 `folderId`** ——
 * 收件匣的目錄、保存處、context 檔的路徑**不經 IPC 送往 renderer**。
 *
 * （**但路徑並非不出主行程**：prompt 含 context 檔的絕對路徑，它會被 pty 畫在終端上。
 * 那是刻意的，也不是破口 —— pty 輸出本來就含任意路徑，renderer 未因此獲得任何 `fs.*` 詞彙。）
 *
 * ## 建立 session 仍然由 renderer 發動
 *
 * session 清單的權威在 renderer：`SessionStore.replace()` 只從 renderer 推來的清單重建，
 * 主行程自行建立的 session 會在 500ms 後被抹掉，**而 pty 還活著**。因此「接受」的回應是
 * 一個**指示**（在哪個 folder 開一個 agent session），renderer 走它既有的 create 路徑，
 * 建好之後再回報 sessionId —— 主行程據此寫 context 檔並排定預填。
 */

export type { IntakeView } from '../intake-projection'
export type { IntakeAcceptResult } from '../intake-accept'

export const INTAKE_CHANNELS = {
  list: 'workspace:intake:list',
  accept: 'workspace:intake:accept',
  /** renderer 建好 session 之後回報，主行程據此寫 context 檔並排定預填。 */
  attach: 'workspace:intake:attach',
  dismiss: 'workspace:intake:dismiss',
  dismissNotices: 'workspace:intake:dismissNotices',
  dismissNotice: 'workspace:intake:dismissNotice',
  /**
   * 把一則**已接受**的從收件匣清除（了結）。它不刪紀錄 —— 去重鍵照常保留 —— 也不碰它的 session。
   */
  settle: 'workspace:intake:settle',
  rules: 'workspace:intake:rules',
  setRules: 'workspace:intake:setRules',
  /** 主行程 → renderer：收件匣有變動。 */
  changed: 'workspace:intake:changed',
  /** 主行程 → renderer：某個 session 的預填狀態（等待送出／已送出／未能填入）。 */
  prefill: 'workspace:intake:prefill',
  /**
   * renderer → 主行程：使用者打開了收件匣。
   *
   * **這是通知上界的重置點**，而它必須是一個獨立的訊號 —— 不能拿 `list` 頂替：
   * 常駐的計數 provider 在啟動時就會呼叫 `list`，拿它當「使用者看過了」會讓那個上界
   * 每次開機自動重置，也就是形同沒有上界。
   */
  opened: 'workspace:intake:opened',
  /** 主行程 → renderer：把收件匣打開（使用者觸發了通知）。 */
  openInbox: 'workspace:intake:openInbox',
  /**
   * 主行程 → renderer：這一則到達時即被接受，請在該 folder 建立 session。
   *
   * **建立仍然由 renderer 做** —— session 清單的權威在它那裡（見檔頭），主行程自己建的
   * session 會在下一次 replace 時被抹掉，**而 pty 還活著**。於是「到達即接受」與「使用者
   * 按下接受」走的是**同一條建立路徑**，那正是既有條款要求的。
   */
  autoAccept: 'workspace:intake:autoAccept',
  /** 主行程 → renderer：把焦點移到某個 session（使用者觸發了一則已建立 session 的通知）。 */
  focusSession: 'workspace:intake:focusSession',
} as const

export interface RuleView extends RoutingRule {
  /** 以第三方撰寫的欄位為判準時為真 —— 編輯介面據此標示它可被投遞者操縱。 */
  spoofable: boolean
}

function sanitizeRules(input: unknown): RoutingConfig {
  const rules: RoutingRule[] = []
  let fallbackFolderId: string | null = null
  if (typeof input === 'object' && input !== null) {
    const value = input as Record<string, unknown>
    if (typeof value.fallbackFolderId === 'string') fallbackFolderId = value.fallbackFolderId
    if (Array.isArray(value.rules)) {
      for (const entry of value.rules) {
        if (typeof entry !== 'object' || entry === null) continue
        const e = entry as Record<string, unknown>
        if (typeof e.id !== 'string' || typeof e.contains !== 'string') continue
        if (typeof e.folderId !== 'string') continue
        const criterion = e.criterion
        if (
          criterion !== 'originKind' &&
          criterion !== 'originId' &&
          criterion !== 'title' &&
          criterion !== 'body' &&
          criterion !== 'actor' &&
          criterion !== 'originLabel'
        ) {
          continue
        }
        rules.push({ id: e.id, criterion, contains: e.contains, folderId: e.folderId })
      }
    }
  }
  return { rules, fallbackFolderId }
}

/** `list` 的回傳形狀。 */
export interface IntakeSnapshot {
  items: IntakeView[]
  /**
   * 拒絕的痕跡 —— **逐則**，不是一個總數。
   *
   * 一個計數器回答不了「哪一則」「為什麼」「我要怎麼辦」中的任何一個，
   * 而使用者對一則他自己交辦的工作正是要問這三件事。
   */
  notices: {
    key: string
    code: string
    count: number
    detail?: string
    at: number
    origin?: string
    target?: string
    permanent: boolean
    /**
     * 這是不是「其餘」那一桶。
     *
     * **由主行程標示，renderer 不認得那個主鍵** —— 讓 renderer 去比對一個主行程的內部常數
     * 會把 `intake-service`（連同它的 `node:fs`）整個拉進 renderer 的 bundle。
     */
    overflow?: boolean
  }[]
}

/** routing 規則的回傳形狀。 */
export interface IntakeRulesSnapshot {
  rules: RuleView[]
  fallbackFolderId: string | null
}

export interface IntakeHandlerDeps {
  service: IntakeService
  routing: RoutingStore
  folders: FolderLookup
  contextRoot: string
  /** 事件回報是否啟用。**關閉時預填永遠不會發生，因此接受之前就要告知。** */
  agentEventsEnabled(): boolean
  /** 使用者打開了收件匣 —— 通知上界的重置點。 */
  onInboxOpened?: () => void
  /**
   * 把「打開收件匣」這個動作交出去，供通知被觸發時呼叫。
   *
   * **以回呼交出而不是導出一個函式**：送出的對象是這一層持有的 `senders`，而那個集合的
   * 生命週期綁在這次註冊上。
   */
  registerOpenInbox?: (open: () => void) => void
  /** 把「請 renderer 在某個 folder 自動建立 session」交出去，供交接的 producer 呼叫。 */
  registerAutoAccept?: (request: (adapter: string, id: string, folderId: string) => void) => void
  /** 把「把焦點移到某個 session」交出去，供通知被觸發時呼叫。 */
  registerFocusSession?: (focus: (sessionId: string) => void) => void
}

export function registerIntakeHandlers(deps: IntakeHandlerDeps): void {
  const { service, routing, folders, contextRoot, agentEventsEnabled, onInboxOpened } = deps
  const senders = new Set<WebContents>()

  const knownIds = (): ReadonlySet<string> => new Set(folders.list().map((f) => f.id))

  // Every inbox change, from either side, goes through the one signal (`intake-changes.ts`); this
  // renderer-facing listener is one of its listeners, the remote server another.
  onIntakeChanged(() => {
    for (const sender of senders) {
      if (sender.isDestroyed()) senders.delete(sender)
      else sender.send(INTAKE_CHANNELS.changed)
    }
  })
  const broadcast = notifyIntakeChanged
  service.subscribe(broadcast)

  ipcMain.handle(INTAKE_CHANNELS.list, (event) => {
    senders.add(event.sender)
    const config = routing.get()
    const ids = knownIds()
    return {
      items: listView(service.store.list(), config, ids),
      notices: service.notices().map((notice) => ({
        ...notice,
        ...(notice.key === OVERFLOW_KEY ? { overflow: true } : {}),
      })),
    }
  })

  // 無回應通道 —— 沒有負載，因此不需要型別 guard（`clipboard:writeText` 那條的成因是它收字串）。
  ipcMain.on(INTAKE_CHANNELS.opened, () => {
    onInboxOpened?.()
  })

  /**
   * 把收件匣打開。**重用既有的 `senders` 集合與其銷毀剪除** —— 另外持有一份參考的話，
   * renderer 重新載入之後那份就指向一個已銷毀的 `WebContents`。
   */
  const openInbox = (): void => {
    for (const sender of senders) {
      if (sender.isDestroyed()) senders.delete(sender)
      else sender.send(INTAKE_CHANNELS.openInbox)
    }
  }
  deps.registerOpenInbox?.(openInbox)

  /**
   * 送一則往 renderer。**重用 `senders` 與其銷毀剪除**，理由與 `openInbox` 相同。
   */
  const send = (channel: string, ...args: unknown[]): void => {
    for (const sender of senders) {
      if (sender.isDestroyed()) senders.delete(sender)
      else sender.send(channel, ...args)
    }
  }

  deps.registerAutoAccept?.((adapter, id, folderId) => {
    send(INTAKE_CHANNELS.autoAccept, adapter, id, folderId, ticketFor(service.store.get(adapter, id), folderId))
  })
  deps.registerFocusSession?.((sessionId) => {
    send(INTAKE_CHANNELS.focusSession, sessionId)
  })

  /**
   * 清除**一則**痕跡。
   *
   * 一次清光全部會讓使用者為了清掉一則第三方投遞的格式錯誤，順手清掉一則他還沒處理的
   * 交接失敗 —— 而後者正是這條通道存在的理由。
   */
  ipcMain.handle(INTAKE_CHANNELS.dismissNotice, (_event, key: unknown, code: unknown) => {
    if (typeof key !== 'string' || typeof code !== 'string') return { ok: false }
    service.dismissNotice(key, code)
    return { ok: true }
  })

  ipcMain.handle(INTAKE_CHANNELS.dismissNotices, () => {
    service.clearNotices()
    return { ok: true }
  })

  ipcMain.handle(INTAKE_CHANNELS.rules, (): IntakeRulesSnapshot => {
    const config = routing.get()
    return {
      rules: config.rules.map((rule) => ({ ...rule, spoofable: isAuthoredCriterion(rule.criterion) })),
      fallbackFolderId: config.fallbackFolderId,
    }
  })

  ipcMain.handle(INTAKE_CHANNELS.setRules, (_event, input: unknown) => {
    routing.replace(sanitizeRules(input))
    broadcast()
    return { ok: true }
  })

  ipcMain.handle(INTAKE_CHANNELS.dismiss, (_event, id: unknown, adapter: unknown) => {
    if (typeof id !== 'string' || typeof adapter !== 'string') return { ok: false, reason: 'unknown' }
    dismissIntake(service.store, adapter, id)
    return { ok: true }
  })

  /**
   * 使用者把一則已開好的項目從收件匣清除。
   *
   * **不是 `dismiss`**：忽略的語意是「沒有建立 session」，而這一則確實建了一個。
   * **只對已接受者生效**（由 store 判定）—— 待處理的清除走忽略。
   */
  ipcMain.handle(INTAKE_CHANNELS.settle, (_event, id: unknown, adapter: unknown) => {
    if (typeof id !== 'string' || typeof adapter !== 'string') return { ok: false }
    service.store.settle(adapter, id)
    broadcast()
    return { ok: true }
  })

  /**
   * 接受一則 intake。
   *
   * **只回傳一個指示**（要在哪個 folder 建立 agent session）—— 建立本身由 renderer 走它既有的
   * 路徑完成，理由見檔頭。狀態要等 `attach` 回報之後才轉為已接受。
   *
   * **folder 是使用者在卡片上確認的那一個**（第三個參數），判定見 `decideAccept`。
   * 這裡**不求 routing** —— 缺了那個參數就拒絕，不退回解析結果。
   */
  ipcMain.handle(
    INTAKE_CHANNELS.accept,
    (_event, id: unknown, adapter: unknown, folderId: unknown): IntakeAcceptResult => {
      if (typeof id !== 'string' || typeof adapter !== 'string') return { ok: false, reason: 'unknown' }
      const record = service.store.get(adapter, id)
      const decision = decideAccept({
        record,
        chosenFolderId: folderId,
        knownFolderIds: knownIds(),
        eventsEnabled: agentEventsEnabled(),
      })
      if (!decision.ok) return decision
      const ticket = ticketFor(record, decision.folderId)
      return ticket ? { ...decision, ticket } : decision
    },
  )

  /**
   * renderer 建好 session 之後回報 —— 主行程據此寫 context 檔並排定預填。
   *
   * context 檔由**攝入當下正規化過的那份內容**產生，**不於此時重新讀取保存處** ——
   * 兩者之間隔著使用者思考的時間，而保存處的內容在那段時間內可能已經改變。
   */
  ipcMain.handle(
    INTAKE_CHANNELS.attach,
    async (event, id: unknown, adapter: unknown, sessionId: unknown) => {
      if (typeof id !== 'string' || typeof adapter !== 'string' || typeof sessionId !== 'string') {
        return { ok: false, reason: 'unknown' }
      }
      const record = service.store.get(adapter, id)
      if (!record?.content) return { ok: false, reason: 'unknown' }

      const intake = {
        id: record.id,
        verified: record.content.verified,
        authored: record.content.authored,
        receivedAt: record.content.receivedAt,
      }
      const nonce = createNonce()
      const target = await writeContext(contextRoot, record.id, buildContext(bodyOf(intake), nonce))
      const firstPartyBody = record.content.verified.firstPartyBody === true
      const prompt = buildPrompt(target, nonce, firstPartyBody)
      // **沿用既有 session 由主行程判定**（record 上已經記著的那一個），不採信 renderer 的說法。
      const mode = prefillModeFor({ firstPartyBody, reusedSession: record.sessionId === sessionId })

      service.store.setState(adapter, id, 'accepted', sessionId)
      broadcast()

      const sender = event.sender
      schedulePrefill(sessionId, prompt, {
        write: (target_, data) => existingTerminalService(sender.id)?.write(target_, data),
        onFilled: () => {
          /**
           * 「使用者送出了」**發生在 pty 之內** —— renderer 與主行程都收不到自己發出的訊號。
           * 唯一的線索是 agent **開始工作了**（判定見 `isSubmitted`：落回未知的不算）。
           * 見到就撤掉標示、把這一則標為了結（它不必再留在收件匣裡等人讀）。
           *
           * 代為送出時同一個判定照用：送出字元偶爾不生效，那時它退回「待送出」的標示
           * （`watchSubmission` 的退路），其後由使用者送出。
           */
          watchSubmission(sessionId, mode, {
            onPending: () => {
              if (!sender.isDestroyed()) sender.send(INTAKE_CHANNELS.prefill, sessionId, 'pending')
            },
            onSubmitted: () => {
              if (!sender.isDestroyed()) sender.send(INTAKE_CHANNELS.prefill, sessionId, 'sent')
              // **只了結這個 session 所屬的那一則**：再次接受時 record 上的關聯會被換成新的
              // session，舊訂閱若晚到，不能把新的那一次一併了結。
              if (service.store.get(adapter, id)?.sessionId === sessionId) {
                service.store.settle(adapter, id)
                broadcast()
              }
            },
          })
        },
        onTimeout: () => {
          // **以狀態為準，不以成因為準。** 回到可重新處理的狀態，並說話。
          service.store.setState(adapter, id, 'pending')
          if (!sender.isDestroyed()) sender.send(INTAKE_CHANNELS.prefill, sessionId, 'timedOut')
          broadcast()
        },
      }, mode)

      return { ok: true }
    },
  )
}

/** session 結束或使用者自己送出時取消待填。 */
export function cancelIntakePrefill(sessionId: string): void {
  cancelPrefill(sessionId)
}
