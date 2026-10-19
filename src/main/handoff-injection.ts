import { INTRO_COMMAND, INTRO_ENV, OUTBOX_ENV, RECEIPTS_ENV, RELATIONS_ENV, writeIntroFile } from './handoff-intro'
import { introFile, outboxDir, prepareOutbox, receiptsDir, relationsFile } from './handoff-outbox'
import { writeRelationsFor, type RelationsWorld } from './handoff-relations'
import type { InjectionContribution } from './agent-injection'
import type { WorkspaceFolder } from './workspace-store'

export type FolderList = readonly Pick<WorkspaceFolder, 'name' | 'path'>[]

/**
 * 交接的注入貢獻。回傳 `null` ＝ 不參與（落點建不起來）。 There is no switch: handoff is a core
 * capability.
 *
 * **它與事件橋接同時貢獻 `SessionStart`，而那是刻意的** —— 實測（2026-09-17、CLI 2.1.274）
 * 同一個事件上的多條命令都會被執行，且每一條的 stdout 都進入脈絡。合成器負責把兩者串接
 * （`agent-injection` 的 `HookContribution`）；**它若逐鍵覆蓋，第二條根本不會出現在送出去的
 * 設定裡，CLI 沒有機會執行一條它沒收到的命令。**
 *
 * **自我介紹寫不出來時仍然注入**：hook 命令會 `cat` 一個不存在的檔案 ⇒ 非零碼 ⇒ 沒有自我介紹，
 * 而 session 照常。反過來把整份貢獻收掉也可以，但那會讓「落點存在卻沒人被告知」與「落點不存在」
 * 混成同一種狀態。
 */
export function prepareHandoffInjection(
  sessionId: string,
  folders: FolderList,
  peer: {
    /** 它的固定名字（`agent-peer-name`）。 */
    name?: string
    /** 算關係用的當下狀態。關係檔在這裡先寫一次 —— 那時這個 session 的 pty 還不在執行中集合裡。 */
    world?: RelationsWorld
    /** 由交接建立 ⇒ 告知它如何回報完成（`handoff-completion`）。 */
    reportable?: boolean
  } = {},
): InjectionContribution | null {
  const outbox = prepareOutbox(sessionId)
  if (!outbox) return null

  const relations = relationsFile(sessionId)
  if (peer.world) writeRelationsFor(sessionId, peer.world)
  writeIntroFile(introFile(sessionId), { folders, outbox, name: peer.name, relations, reportable: peer.reportable })

  return {
    settings: {},
    hooks: { SessionStart: [INTRO_COMMAND] },
    env: { [INTRO_ENV]: introFile(sessionId), [OUTBOX_ENV]: outbox, [RECEIPTS_ENV]: receiptsDir(sessionId), [RELATIONS_ENV]: relations },
  }
}

/**
 * workspace 的 folder 清單變動時，重寫每一個活著的 session 的自我介紹。
 *
 * **少了這個，「清單取當下的值」只在 spawn 那一刻成立** —— 而 hook 會在續接、壓縮、清除時
 * 重跑，那些時刻讀到的就是一份過期的清單。失效方式是靜默的：agent 交接給一個剛被移除的 repo，
 * 得到一次它看不到的拒絕。
 */
export function refreshIntros(
  sessionIds: readonly string[],
  folders: FolderList,
  /**
   * 每個 session 的固定名字。**重寫時一定要帶上** —— 否則 folder 清單一變動，自我介紹就被重寫成
   * 不含名字的版本，下一次續接、壓縮、清除時 agent 就不知道自己叫什麼。
   */
  nameOf: (sessionId: string) => string | undefined,
  /**
   * 這個 session 是否由交接建立（`handoff-completion`）。**與名字同一條理由**：重寫時漏掉它，
   * 下一次續接、壓縮、清除之後子 agent 就不知道要回報完成，而那個 session 永遠停在「等你」。
   */
  reportableOf: (sessionId: string) => boolean = () => false,
): void {
  for (const sessionId of sessionIds) {
    const outbox = outboxDir(sessionId)
    if (!outbox) continue
    writeIntroFile(introFile(sessionId), {
      folders,
      outbox,
      name: nameOf(sessionId),
      relations: relationsFile(sessionId),
      reportable: reportableOf(sessionId),
    })
  }
}
