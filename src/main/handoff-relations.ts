import fs from 'node:fs'
import path from 'node:path'

import { ancestryOf } from '../shared/lineage/ancestry'
import { sessionExists } from '../shared/lineage/existence'
import { preferredTitle } from '../shared/lineage/label'
import type { LifecycleState } from '../shared/lineage/lifecycle'
import { relationsDir, relationsFile } from './handoff-outbox'
import type { PersistedSession } from './session-store'

/**
 * 關係檔 —— agent 隨時查得到它當下的母、子、兄弟 session（`session-lineage`）。
 *
 * ## 為什麼是一個檔案，而不是寫進自我介紹
 *
 * 自我介紹只在 `SessionStart` 進入 agent 的脈絡，**重寫它進不了正在跑的 agent**。母 session 的
 * 子 session 是在它啟動之後才長出來的 —— 只寫在自我介紹裡的話，母 session 永遠看不到自己的
 * 子 session。自我介紹只告訴 agent 這個檔案在哪裡；檔案由主行程隨時更新。
 *
 * ## 內容只有 agent 需要的東西
 *
 * 名字（聯絡用的地址）、repo 名稱、標籤、是否在執行。**沒有 spekterm 的識別碼、沒有任何路徑欄位。**
 * 標籤是 agent 可控的文字（pty 宣告、或使用者輸入）—— 它以 JSON 字串出現，agent 讀它是為了挑對象。
 */

/** 全域 session 在關係檔裡的 repo 名稱。與固定名字的前綴同一個字（它是給 agent 看的，不翻譯）。 */
export const GLOBAL_REPO = 'global'

export interface RelatedSession {
  name?: string
  repo: string
  title?: string
  running: boolean
  /**
   * 生命週期（`handoff-completion`）—— 只有由交接建立的子／兄弟 session 才有。`idle` ＝ 此刻沒有狀態可說
   * （休眠、已結束、或等待狀態未知）。
   */
  state?: LifecycleState
  /** 最新一份完成報告的摘要（有的話）。母 session 錯過訊息時從這裡讀得到結果。 */
  summary?: string
  /**
   * The sessions this one handed off, and so on at every depth (`agent-session-control` design D5). Present only on
   * a descendant entry that has descendants of its own; absent on the parent and on siblings.
   */
  children?: RelatedSession[]
  /**
   * This descendant's direct parent no longer exists (closed, or its folder left the workspace), so it hangs under
   * its nearest ancestor that does. Not "closed": a parent can be gone without having been closed.
   */
  parentGone?: true
}

export interface ClosedParent {
  closed: true
  repo?: string
  title?: string
}

export interface Relations {
  self: { name?: string }
  parent: RelatedSession | ClosedParent | null
  children: RelatedSession[]
  siblings: RelatedSession[]
}

export interface RelationsWorld {
  /** 含暫定紀錄的 session 視圖（`SessionStore.view()`）。 */
  view: readonly { session: PersistedSession; provisional: boolean }[]
  /** workspace 目前的 folder。 */
  folders: readonly { id: string; name: string }[]
  /** 目前持有 pty 的 session。 */
  running: ReadonlySet<string>
  /** 由交接建立的 session 的生命週期（`handoff-completion`）。缺席 ＝ 不提供。 */
  lifecycle?: ReadonlyMap<string, { state: LifecycleState; summary?: string }>
}

function labelOf(session: PersistedSession): string | undefined {
  return preferredTitle(session)
}

/**
 * 算出某個 session 的關係。「存在」依 `src/shared/lineage/existence.ts` —— renderer 畫樹用的是
 * 同一個規則，於是畫面與 agent 看到的不會分歧。
 */
export function relationsOf(selfId: string, world: RelationsWorld): Relations | null {
  const folderNames = new Map(world.folders.map((folder) => [folder.id, folder.name]))
  const exists = (entry: { session: PersistedSession; provisional: boolean }): boolean =>
    sessionExists({
      inList: true,
      // 主行程裡沒有「已結束而仍在清單中」這種狀態：pty 自行結束的 session 當下就被移出 store。
      exited: false,
      folderInWorkspace: entry.session.folderId === null || folderNames.has(entry.session.folderId),
      provisional: entry.provisional,
      ptyAlive: world.running.has(entry.session.id),
    })
  const live = world.view.filter(exists)
  const byId = new Map(live.map((entry) => [entry.session.id, entry.session]))

  const self = byId.get(selfId)
  if (!self) return null

  const describe = (session: PersistedSession, withLifecycle = false): RelatedSession => {
    const title = labelOf(session)
    const lifecycle = withLifecycle ? world.lifecycle?.get(session.id) : undefined
    return {
      ...(session.peerName ? { name: session.peerName } : {}),
      repo: session.folderId === null ? GLOBAL_REPO : (folderNames.get(session.folderId) ?? ''),
      ...(title ? { title } : {}),
      running: world.running.has(session.id),
      ...(lifecycle ? { state: lifecycle.state } : {}),
      ...(lifecycle?.summary ? { summary: lifecycle.summary } : {}),
    }
  }

  let parent: Relations['parent'] = null
  const lineage = self.lineage
  if (lineage) {
    const alive = byId.get(lineage.parentId)
    if (alive) {
      parent = describe(alive)
    } else {
      // 快照的歸屬是三態 —— **未知不是全域**，於是那時不寫 repo。
      const origin = lineage.origin
      const repo =
        origin.kind === 'folder' ? origin.folderName : origin.kind === 'global' ? GLOBAL_REPO : undefined
      parent = {
        closed: true,
        ...(repo !== undefined ? { repo } : {}),
        ...(lineage.parentTitle ? { title: lineage.parentTitle } : {}),
      }
    }
  }

  const children = descendantTree(selfId, live, world.view, (session) => describe(session, true))

  // **兄弟以同一個 parentId 判定，不以母 session 是否存在判定** —— 母 session 關閉之後，它交接出來
  // 的那幾件事並沒有因此結束，它們之間仍可能需要協調。
  const siblings = lineage
    ? live
        .filter((entry) => entry.session.id !== selfId && entry.session.lineage?.parentId === lineage.parentId)
        .map((entry) => describe(entry.session, true))
    : []

  return { self: { ...(self.peerName ? { name: self.peerName } : {}) }, parent, children, siblings }
}

/**
 * The descendants of `selfId` as a tree: each hangs under its nearest existing ancestor within the subtree, and
 * one whose direct parent is gone says so.
 *
 * The chain is walked over **every record** (`all`), not only the existing ones: a session whose folder left the
 * workspace still links its descendants to their ancestors. Existence (`live`) only decides who is listed, the same
 * split command authorization uses, so "listed in the tree" and "may be commanded" cannot come apart.
 */
function descendantTree(
  selfId: string,
  live: readonly { session: PersistedSession }[],
  all: readonly { session: PersistedSession }[],
  describe: (session: PersistedSession) => RelatedSession,
): RelatedSession[] {
  const records = new Map(all.map((entry) => [entry.session.id, entry.session]))
  const liveIds = new Set(live.map((entry) => entry.session.id))
  const under = new Map<string, PersistedSession[]>()
  for (const { session } of live) {
    if (session.id === selfId) continue
    const chain = ancestryOf(session.id, (id) => records.get(id))
    const reach = chain.indexOf(selfId)
    if (reach < 0) continue
    // The nearest ancestor that is listed: a descendant of self that exists, or self.
    const hang = chain.slice(0, reach).find((id) => liveIds.has(id)) ?? selfId
    under.set(hang, [...(under.get(hang) ?? []), session])
  }
  const build = (id: string): RelatedSession[] =>
    (under.get(id) ?? []).map((session) => {
      const entry = describe(session)
      const nested = build(session.id)
      return {
        ...entry,
        ...(session.lineage?.parentId !== id ? { parentGone: true as const } : {}),
        ...(nested.length > 0 ? { children: nested } : {}),
      }
    })
  return build(selfId)
}

/** 最近一次寫出的內容 —— 只寫有變的檔。 */
const written = new Map<string, string>()

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.partial`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

/** 寫出一個 session 的關係檔（spawn 當下由交接的注入呼叫 —— 那時它還不在 `running` 裡）。 */
export function writeRelationsFor(sessionId: string, world: RelationsWorld): string | null {
  const file = relationsFile(sessionId)
  if (!file) return null
  const relations = relationsOf(sessionId, { ...world, running: new Set([...world.running, sessionId]) })
  if (!relations) return null
  const content = `${JSON.stringify(relations, null, 2)}\n`
  try {
    if (written.get(sessionId) !== content) {
      writeAtomic(file, content)
      written.set(sessionId, content)
    }
    return file
  } catch (error) {
    console.error(`[handoff] relations write failed: ${String(error)}`)
    return null
  }
}

/**
 * **單一觸發點**（`handoff-lineage` design D6）：任何會改變「關係、存在、執行中、標籤、名字」的事
 * 之後都呼叫它。它重算**所有**執行中的 claude session、只寫內容有變的檔，並刪掉不再執行者的檔。
 *
 * 逐一列舉觸發點再各自更新受影響的那幾個檔 —— 設計第一版就是那樣，而漏掉任何一個都是靜默的。
 */
export function refreshRelations(world: RelationsWorld & { agents: readonly string[] }): void {
  const keep = new Set(world.agents)
  for (const sessionId of keep) writeRelationsFor(sessionId, world)

  const dir = relationsDir()
  if (!dir) return
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const sessionId = entry.slice(0, -'.json'.length)
    if (keep.has(sessionId)) continue
    written.delete(sessionId)
    try {
      fs.rmSync(path.join(dir, entry), { force: true })
    } catch {
      // 刪不掉就留著：下一次 refresh 會再試。它不在任何 agent 的環境變數裡了。
    }
  }
}

/** 供測試重置。 */
export function resetRelationsState(): void {
  written.clear()
}
