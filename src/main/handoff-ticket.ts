import { randomBytes } from 'node:crypto'
import type { SessionLineage } from '../shared/lineage/types'
import { bodyOf } from './intake-schema'
import type { IntakeRecord } from './intake-store'

/**
 * 交接的**單次憑證**（`session-lineage`「由交接建立的 session 於建立當下記住它的來源 session」）。
 *
 * renderer 建立一個子 session 時，要讓主行程知道「這個新 session 是為哪一則交接開的」—— 主行程
 * 才能在 **spawn 之前**把來源寫進去（自我介紹與關係檔於是第一次就對）。但 renderer 不能宣告關係：
 *
 * - **直接交 intake 的主鍵不行**：record 永不刪除、了結之後狀態仍是 accepted，任何一則歷史上的
 *   交接都能被無限次引用來產生「子 session」。
 * - **在 `attach` 寫入不行**：`attach` 的 sessionId 由 renderer 提供、不檢查狀態，等於讓 renderer
 *   把任何既有 session 掛成子節點；而那時 spawn 早已完成。
 *
 * 所以由主行程在**它自己決定**要為某則交接建立 session 的那一刻簽發（送出自動接受的推送、`accept`
 * 成功），綁定 record、folder 與 claude 目標，用過即作廢、逾時即失效。renderer 只能原樣轉交它。
 */

/** 簽發到被使用之間的上限。renderer 收到後立刻建立 session，正常情況下是毫秒級。 */
export const TICKET_TTL_MS = 60_000

export interface TicketClaim {
  adapter: string
  id: string
  folderId: string
}

interface Entry extends TicketClaim {
  expiresAt: number
}

export class TicketStore {
  readonly #entries = new Map<string, Entry>()
  /**
   * Records whose ticket was used to create a session that has not attached yet, until `release` or expiry. With
   * the unused tickets they make "this handoff is being opened" (`scheduled-handoff`, design D3): an accept in
   * between must not create a second session.
   */
  readonly #claimed = new Map<string, number>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  issue(claim: TicketClaim): string {
    this.#sweep()
    const token = randomBytes(16).toString('hex')
    this.#entries.set(token, { ...claim, expiresAt: this.#now() + TICKET_TTL_MS })
    return token
  }

  /**
   * 消費一張憑證。**不論是否相符都會作廢** —— 一張被拿來試錯的憑證不該還能再試一次。
   *
   * 只有 claude 目標、且 folder 與簽發時相同才回傳它綁定的 record。
   */
  consume(token: unknown, folderId: string | null, spawnTarget: string): TicketClaim | null {
    this.#sweep()
    if (typeof token !== 'string') return null
    const entry = this.#entries.get(token)
    if (!entry) return null
    this.#entries.delete(token)
    if (spawnTarget !== 'claude' || folderId !== entry.folderId) return null
    this.#claimed.set(claimKey(entry.adapter, entry.id), entry.expiresAt)
    return { adapter: entry.adapter, id: entry.id, folderId: entry.folderId }
  }

  /** Whether a session is being opened for this record: an unexpired ticket, or one used and not yet attached. */
  isLive(adapter: string, id: string): boolean {
    this.#sweep()
    if (this.#claimed.has(claimKey(adapter, id))) return true
    for (const entry of this.#entries.values()) if (entry.adapter === adapter && entry.id === id) return true
    return false
  }

  /** The record's session attached (`intake:attach`): it is no longer being opened. */
  release(adapter: string, id: string): void {
    this.#claimed.delete(claimKey(adapter, id))
  }

  #sweep(): void {
    const now = this.#now()
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(token)
    }
    for (const [key, expiresAt] of this.#claimed) {
      if (expiresAt <= now) this.#claimed.delete(key)
    }
  }
}

/**
 * 這個行程的憑證。簽發在 `ipc/intake.ts`、消費在 `ipc/terminal.ts` —— 兩者都只經由它。
 */
export const handoffTickets = new TicketStore()

function claimKey(adapter: string, id: string): string {
  return `${adapter}\u0000${id}`
}

/**
 * 由憑證綁定的 record 取出它記下的來源。**由主行程啟動時接上**（`index.ts`）—— 這個模組不認識
 * 收件匣的 store，與 `configureHandoff` 同一個姿態。
 */
/**
 * 一張憑證解析出來的東西：來源（`lineage`，含交接單留在清單裡的標題），以及交接單的本文
 * （`handoff-brief`）—— 本文另存一個檔，於是它不能跟著 `lineage` 進 `sessions.json`。
 */
export interface TicketResolution {
  lineage: SessionLineage
  briefBody?: string
}

let resolveSource: ((claim: TicketClaim) => TicketResolution | undefined) | null = null

export function configureTicketLineage(resolve: ((claim: TicketClaim) => TicketResolution | undefined) | null): void {
  resolveSource = resolve
}

/**
 * 建立 session 時呼叫：消費憑證並回傳要寫進新 session 的來源。**沒有憑證、不相符、或那一則沒有
 * 來源時回 `undefined`** —— session 照常建立，只是沒有來源。
 */
export function lineageFromTicket(token: unknown, folderId: string | null, spawnTarget: string): TicketResolution | undefined {
  if (token === undefined) return undefined
  const claim = handoffTickets.consume(token, folderId, spawnTarget)
  return claim ? resolveSource?.(claim) : undefined
}

/**
 * 替「主行程決定要為它建立 session」的那一則交接簽發單次憑證。
 *
 * **只對帶來源、且仍待處理的 record 簽發** —— 一則已接受或已了結的交接不該再長出子 session；
 * 沒有來源（外部 producer、舊版留下的交接）則根本沒有關係可寫。
 *
 * **Issuing marks the handoff's one automatic opening as used** (`markFired`, saved at once) — the opener's
 * request and the user's accept alike — and **one live ticket per record**: none while one is unexpired or used
 * and not yet attached (`scheduled-handoff`, design D3).
 */
export function ticketFor(
  record: IntakeRecord | undefined,
  folderId: string,
  tickets: TicketStore = handoffTickets,
  markFired?: (adapter: string, id: string) => void,
): string | undefined {
  if (record) markFired?.(record.adapter, record.id)
  if (!record?.content?.verified.source || record.state !== 'pending') return undefined
  if (tickets.isLive(record.adapter, record.id)) return undefined
  return tickets.issue({ adapter: record.adapter, id: record.id, folderId })
}

/**
 * 由一則 intake 紀錄推出「為它建立的 session」該帶的來源與交接單。
 *
 * **交接單只給 agent 發起的交接**（`handoff-brief`），取攝入時正規化過的那一份 —— 與 context 檔、
 * 收件匣的呈現是同一個值。**它是快照**：intake 的內容有保留期限，以主鍵回查會在某一天查到空的。
 */
export function ticketResolutionFor(record: IntakeRecord | undefined): TicketResolution | undefined {
  const content = record?.content
  const source = content?.verified.source
  if (!record || !content || !source) return undefined
  const brief = content.verified.firstPartyBody === true
  return {
    lineage: {
      parentId: source.sessionId,
      origin: source.origin,
      ...(source.title ? { parentTitle: source.title } : {}),
      ...(brief ? { brief: { title: content.authored.title, receivedAt: content.receivedAt } } : {}),
      // Copied, never recomputed here: the chain is the one taken at ingestion (`agent-session-control` D4).
      ...(source.ancestors?.length ? { ancestors: [...source.ancestors] } : {}),
    },
    // **經 `bodyOf()`** —— 呈現、交付與交接單取的是同一個值（`intake-context-source` 守著這條）。
    ...(brief ? { briefBody: bodyOf({ id: record.id, ...content }) } : {}),
  }
}
