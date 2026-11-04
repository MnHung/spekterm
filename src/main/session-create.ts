import { randomUUID } from 'node:crypto'

import type { SessionLineage } from '../shared/lineage/types'
import { lineageFromTicket, linkTeammateSession } from './handoff-ticket'
import { decidePeerName } from './peer-name'
import type { SessionStore } from './session-store'
import type { SpawnTarget } from './terminal'

/**
 * 建立一個**新** session 的主行程編排（`handoff-lineage` design D2）。
 *
 * 順序是承重的：**識別碼 → 來源與名字 → 暫定紀錄 → spawn**。自我介紹與關係檔在 spawn 時寫出，
 * 而 renderer 要等 ~500ms 才會把這個 session 送來持久化 —— 來源與名字若不在 spawn 之前就落在
 * 暫定紀錄裡，子 session 的 agent 第一次被注入時就看不到它的母 session，也不知道自己叫什麼。
 *
 * **重建既有 session 不走這裡**（`wake` 帶著既有的識別碼，而它根本不收憑證）—— 對一個已經存在
 * 的 session 寫入來源，在介面上表達不出來。
 *
 * 抽成獨立模組是為了能被單元測試：IPC 那一層會載入 Electron。
 */
export async function createSession<R extends { sessionId: string; conversationId?: string }>(input: {
  sessions: SessionStore
  folderId: string | null
  target: SpawnTarget
  /** rail 項目名稱（名字的前綴）。`null` ＝ 全域。 */
  railLabel: string | null
  /** renderer 轉交的單次憑證。不受信任 —— 形狀不對、不相符、用過的一律視為沒有。 */
  ticket: unknown
  spawn: (sessionId: string, peerName: string | undefined) => Promise<R>
}): Promise<R & { lineage?: SessionLineage }> {
  const { sessions, folderId, target } = input
  const sessionId = randomUUID()
  const resolution = lineageFromTicket(input.ticket, folderId, target)
  const lineage = resolution?.lineage
  // **交接單在 spawn 之前寫出**（`handoff-brief`）—— 與來源、名字同一個理由：它屬於這個 session
  // 誕生的那一刻，而不是 renderer 送來持久化的那一刻。
  if (resolution?.briefBody !== undefined) sessions.writeHandoffBrief(sessionId, { body: resolution.briefBody })
  // **同步地**決定並登記 —— 兩個並行的 create 不會在 await 之間拿到同一個名字。
  const peerName = target === 'claude' ? decidePeerName(input.railLabel, sessionId, sessions.peerNames()) : undefined
  // A teammate's handoff (`teammate-handoff-return` D7): the link is on the provisional record before the spawn, so
  // the first introduction already carries the teammate report paragraph.
  const teammateHandoff = resolution?.teammate
  sessions.addProvisional({ id: sessionId, folderId, spawnTarget: target, lineage, peerName, ...(teammateHandoff ? { teammateHandoff } : {}) })
  linkTeammateSession(sessionId, teammateHandoff)

  let result: R
  try {
    result = await input.spawn(sessionId, peerName)
  } catch (error) {
    // 建不起來的 session 永遠不會被 renderer 送來 —— 它的暫定紀錄要當場撤掉。
    sessions.remove(sessionId)
    throw error
  }
  return { ...result, ...(lineage ? { lineage } : {}) }
}
