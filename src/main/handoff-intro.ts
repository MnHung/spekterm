import fs from 'node:fs'
import path from 'node:path'

import { MAX_FIELD_LENGTH, MAX_FIRST_PARTY_BODY_LENGTH } from './intake-schema'
import { MAX_DELIVERY_BYTES } from './intake-source'
import { MAX_REPORT_LENGTH, MAX_SCHEDULE_AHEAD_DAYS } from './handoff-delivery'
import { receiptsDir } from './handoff-outbox'
import type { WorkspaceFolder } from './workspace-store'

/**
 * 自我介紹 —— spekterm 告訴 agent 自己的存在、可交接的對象與投遞方式。
 *
 * ## 為什麼經 `SessionStart` hook 而不是命令列
 *
 * 可交接的對象是 workspace 的 folder 清單，**它在 session 存活期間會變**。hook 於
 * `startup` / `resume` / `compact` / `clear` 都會重跑，讀檔於是每次都拿到當下的值；
 * 把文字烘進命令列則永遠是 spawn 當下的那一份。
 *
 * ## 實測過的前提（2026-09-17、CLI 2.1.274，見 `docs/lessons/handoff.md`）
 *
 * - hook 的 stdout 若是合法的 `hookSpecificOutput` JSON，其 `additionalContext` 進入脈絡。
 * - **同一個事件上的多條命令都會被執行，且每一條的內容都進入脈絡** —— 這是本能力可行的前提，
 *   因為事件橋接**已經**佔用了 `SessionStart`。
 * - 純文字與**格式壞掉的 JSON 會原樣進入脈絡**。於是這個檔案不是一條「格式對才算數」的通道：
 *   **寫進去的每一個位元組都要當成會被 agent 讀到。**
 * - 命令以非零碼結束時 stdout 不進入脈絡，而 session 照常完成 —— `cat` 一個不存在的檔案正好
 *   落在這條路徑上，那就是我們要的降級方向。
 *
 * ## 文字是英文
 *
 * 與 UI 文案是兩件不同的事：這段文字**不進字典**（沒有使用者會讀到它，它的讀者是 agent），
 * 但它仍然必須是英文 —— `copy-language.test.mjs` 對產品原始碼的 CJK 字面值是一刀切的，
 * 而一刀切是對的。
 */

/** hook 命令的範本。`cat` 失敗（檔案不在）⇒ 非零碼 ⇒ 沒有自我介紹，session 照常。 */
export const INTRO_COMMAND = 'cat "$SPEKTERM_HANDOFF_INTRO" 2>/dev/null'

/** 告知 agent 檔案位置的環境變數。 */
export const INTRO_ENV = 'SPEKTERM_HANDOFF_INTRO'

/** 告知 agent 投遞落點的環境變數。 */
export const OUTBOX_ENV = 'SPEKTERM_HANDOFF_DIR'
/** Where the agent reads the receipt for each file it writes (`handoff-receipt`). */
export const RECEIPTS_ENV = 'SPEKTERM_HANDOFF_RECEIPTS'

/** 告知 agent 關係檔位置的環境變數（`session-lineage`）。 */
export const RELATIONS_ENV = 'SPEKTERM_HANDOFF_RELATIONS'

export interface IntroInput {
  /** 可交接的對象。**它就是查表的定義域所取自的同一份清單**（見 `handoff-target`）。 */
  folders: readonly Pick<WorkspaceFolder, 'name' | 'path'>[]
  /** 這個 session 的投遞落點。 */
  outbox: string
  /** This session's receipts directory (`handoff-receipt`). Absent: derived from the outbox's session id. */
  receipts?: string
  /** 這個 session 的固定名字（`agent-peer-name`）。沒有時不提名字那一句。 */
  name?: string
  /** 這個 session 的關係檔。沒有時不提關係那一段。 */
  relations?: string
  /**
   * 這個 session **由交接建立**（不論母 session 此刻在不在）⇒ 告知它如何回報完成（`handoff-completion`）。
   *
   * **每一個寫出點都要帶上它** —— spawn 時與 folder 清單變動時的重寫。後者漏掉的話，下一次續接、
   * 壓縮、清除之後子 agent 就不知道要回報，而那個 session 永遠停在「等你」。
   */
  reportable?: boolean
}

/**
 * The introduction's hard limit, in characters (`agent-handoff-source`, `scheduled-handoff` design D10).
 *
 * Measured with Claude Code 2.1.303, in `-p` and interactive mode alike: 10,000 characters reach the agent whole;
 * 10,001 are replaced by a file pointer and a preview of the first ~2,000 characters — the agent then keeps only
 * the opening, and every rule after it is gone at once (`docs/lessons/handoff.md` §16). A workspace whose full
 * list would cross this limit gets a shortened list instead (`introText`).
 */
export const INTRO_HARD_LIMIT = 9_000

/**
 * 組出要放進 agent 脈絡的那段文字。
 *
 * **目標可以是名稱或絕對路徑，而這件事一定要講** —— 顯示名稱取自路徑的最後一段，同名是真實
 * 可達的，而歧義對 agent 是一條死路：它不會自己想到換一種寫法。
 *
 * **The list is cut, never the rules**: over `INTRO_HARD_LIMIT`, the repos that fit are listed in workspace
 * order, with how many were left out. Losing the list's tail costs some targets; crossing the CLI's threshold
 * costs the whole introduction.
 */
export function introText(input: IntroInput): string {
  const full = composeIntro(input, input.folders.length)
  if (full.length <= INTRO_HARD_LIMIT) return full
  let shown = input.folders.length
  let text = full
  while (shown > 0 && text.length > INTRO_HARD_LIMIT) {
    shown -= 1
    text = composeIntro(input, shown)
  }
  return text
}

function composeIntro({ folders, outbox, receipts, name, relations, reportable }: IntroInput, shown: number): string {
  /**
   * **數字由實際生效的常數推導，不寫死。**
   *
   * 一份手寫的、宣稱自己完整的清單會在某一次調整之後與實際判定分岔，**而分岔不會讓任何
   * 東西變紅** —— 與「把可交接對象的清單做成快照而非取當下值」是同一個失效方式。
   * 這件事已經以最壞的形式發生過一次：長度上限從未被告知，一則超過它的交接被消費、
   * 沒有留下痕跡，而來源 agent 回報「已寫出」。
   *
   * 守衛見 `scripts/handoff-intro-source.test.mjs`：這些數字不得以字面值出現在本檔案。
   */
  const deliveryKb = Math.floor(MAX_DELIVERY_BYTES / 1024)
  const receiptsPath = receipts ?? receiptsDir(path.basename(outbox))
  const lines = [
    'You are running inside spekterm, a desktop workspace that hosts this terminal session.',
    '',
    'You can hand work off to another repo in this workspace. Write a JSON file into your outbox:',
    `  ${outbox}`,
    'The file must end in .json; give each delivery a new file name.',
    'Write it atomically: write to a temporary name that does NOT end in .json (or one starting with a dot), then rename it into place.',
    'A half-written .json file is read and rejected.',
    '',
    'Shape:',
    '  {"target": "<repo name or absolute path>", "title": "<one line>", "body": "<the handoff>", "at": "<optional>"}',
    '',
    'Limits - a delivery that breaks any of these is rejected:',
    `  title: at most ${MAX_FIELD_LENGTH} characters.`,
    `  body:  at most ${MAX_FIRST_PARTY_BODY_LENGTH} characters: past that, the receiving agent cannot read all of it, and the end silently never reaches them.`,
    `  whole file: at most ${deliveryKb} KB.`,
    '  If the work needs more, write the detail to a file in the target repo and point to it from the body.',
    `  at: leave it out to open the handoff now. To open it later, an ISO 8601 time with an offset (2027-01-15T09:00:00+01:00, or Z). No offset, a date that does not exist, or more than ${MAX_SCHEDULE_AHEAD_DAYS} days ahead is rejected; a time not later than now opens at once.`,
    '      A scheduled handoff opens only while spekterm runs: if its time passed while spekterm was closed, it opens at the next start. It always opens a new session.',
    '',
    'The target must match one of the repos below exactly (case-insensitive) by name, or by its absolute path.',
    'Names are not unique; if two repos share a name, use the absolute path. Partial or fuzzy matches are rejected.',
    '',
    ...repoLines(folders, shown),
    '',
    'When a handoff is accepted, spekterm opens a new agent session in the target repo with the body prepared, and sends its first prompt as soon as that agent is ready. It starts working without waiting for the user.',
    '',
    'For every file you write into your outbox, spekterm writes a receipt with the same name into:',
    `  ${receiptsPath}`,
    'A file gone from your outbox means its receipt exists. Its "status" is one of:',
    '  accepted  - a handoff: its session is being opened; a report: taken; a command: accepted to be carried out.',
    '  scheduled - a handoff that opens at "at".',
    '  duplicate - the same content was received before; nothing new happened.',
    '  rejected  - refused; "code" and "reason" say why. "permanent": false means it can succeed once something changes.',
    '  held      - not processed yet; the file stays and is read again ("reason" says when).',
    'A rejected handoff is also shown to the user in their inbox. An accepted handoff is checked again when it opens; a failure then reaches the user, not the receipt.',
    'Until you have read the receipt, say that you wrote the handoff, not that it was delivered.',
    ...peerLines(name, relations),
    ...commandLines(Boolean(relations)),
    ...(reportable ? reportLines() : []),
  ]
  return lines.join('\n')
}

/**
 * The repo list, grouped by parent directory (`agent-handoff-source`): each directory once, then the names in it,
 * one per line. **The listed name is derived from the path here**, not taken from the folder's `name`, so the
 * grouping cannot drift from the paths if a display name is ever added. A folder at the root has no last segment
 * and is listed by its path.
 */
function repoLines(folders: IntroInput['folders'], shown: number): string[] {
  if (folders.length === 0) return ['Repos in this workspace:', '  (none)']
  const groups = new Map<string, string[]>()
  for (const folder of folders.slice(0, shown)) {
    const dir = path.dirname(folder.path)
    const names = groups.get(dir) ?? []
    names.push(path.basename(folder.path) || folder.path)
    groups.set(dir, names)
  }
  const lines = ['Repos in this workspace, by directory. A repo\'s absolute path is its directory, "/", and its name:']
  for (const [dir, names] of groups) lines.push(`  ${dir}`, ...names.map((repo) => `    ${repo}`))
  const left = folders.length - shown
  if (left > 0) lines.push(`  (${left} more not listed, to keep this introduction whole)`)
  return lines
}

/**
 * The session commands (`agent-session-control`). **Told to every agent session**: every agent can act on itself.
 *
 * The limit is derived from the constant the judgement uses (`scripts/handoff-intro-source.test.mjs` forbids the
 * literal): an unstated constraint costs a refused command.
 */
function commandLines(hasRelations: boolean): string[] {
  return [
    '',
    'You can also ask spekterm to close, hibernate or rename a session: write one of these into your outbox, by the same rules:',
    '  {"kind": "close"}',
    '  {"kind": "hibernate"}',
    '  {"kind": "rename", "name": "<new label>"}',
    hasRelations
      ? 'With no "target" it acts on your own session. Add "target": "<name>" to act on a session you handed off, or one they handed off: use a name from the "children" tree of your relations file.'
      : 'With no "target" it acts on your own session. Add "target": "<name>" to act on a session you handed off, or one they handed off, by its name.',
    'Your parent, your siblings and any other session are refused.',
    'Close ends the session and removes it. Hibernate ends its process but keeps it, dormant, until the user wakes it.',
    'Both wait until the target finishes its current turn, so make a command on your own session your last action.',
    'Closing your own session does not close it: once your reply ends, the user is offered to close or keep it, and it stays open until they choose.',
    'If the user types into the target before a command is carried out, it is dropped. Close and hibernate of a running session need agent event reporting to be on.',
    `Rename takes effect at once and changes only the label. "name" is at most ${MAX_FIELD_LENGTH} characters, on one line; an empty name gives naming back to the terminal title. No name used for messaging changes.`,
    'A command\'s receipt says it was accepted, not that it was carried out. For a session you handed off, your relations file shows the result: a closed one is gone, a hibernated one has "running": false, a renamed one shows the new "title".',
  ]
}

/**
 * 子 session 的完成回報（`handoff-completion`）。**只對由交接建立的 session 說。**
 *
 * 上限由常數推導（`scripts/handoff-intro-source.test.mjs` 擋字面值）—— 一個未被告知的約束
 * 就是一次被拒的回報。
 */
function reportLines(): string[] {
  return [
    '',
    'This session was opened by a handoff. Each time you finish something your parent session or the user asked of you, report it:',
    '  1. Write into your outbox, by the same rules: {"kind": "report", "summary": "<what you did and how it turned out>"}',
    `     summary: at most ${MAX_REPORT_LENGTH} characters, and not empty; a longer or empty one is rejected, not shortened. Put details in a file in this repo and point to it.`,
    '  2. Then read your relations file. If your parent has "running": true, send it the same summary with SendMessage. If not, or you have no parent any more, do not: spekterm keeps your report for it.',
    'A report tells the user this piece of work is done. Report again after each later request you finish.',
  ]
}

/**
 * 名字與母子兄弟關係的那一段（`session-lineage`、`agent-peer-name`）。
 *
 * **它只指向關係檔，不列出關係** —— 這段文字只在 `SessionStart` 進入脈絡，而子 session 是在那
 * 之後才長出來的。列在這裡的關係對母 session 永遠是過期的。
 *
 * 此前這裡有一句「使用者送出第一則 prompt 之前不要傳訊息給剛交接出去的 session」—— 那時第一則
 * prompt 由使用者送出，而一則過早的訊息會讓那則交接被當成已送出。自 `handoff-session-lifecycle`
 * 起第一則 prompt 被代為送出，那句話的前提不在了。
 */
function peerLines(name: string | undefined, relations: string | undefined): string[] {
  if (!name && !relations) return []
  return [
    '',
    ...(name ? [`Your name for Claude Code's local session messaging is: ${name}`] : []),
    ...(relations
      ? [
          'Your parent, your children and your siblings (other sessions your parent handed off) are listed, with their current names and whether they are running, in:',
          `  ${relations}`,
          'It is kept up to date, including sessions created after you started. If this session was opened by a handoff, it has a parent.',
          "To contact one, use Claude Code's own session messaging (ListAgents / SendMessage), addressed by the name in that file; spekterm does not carry the message.",
          'A session listed with "running": false is hibernated: it still exists but cannot receive messages. It comes back when the user wakes it; spekterm will not start it for you, and you must not try to wake it yourself.',
          'A message can also go unanswered - if you need a reply, ask for one.',
          'Each child and sibling also has a "state" (working, waiting, done, or idle) and, once it has reported finishing its work, a "summary".',
          'Children nest: a child lists the sessions it handed off under its own "children", at every depth. A descendant marked "parentGone": true lost its direct parent (closed, or its repo left the workspace) and is listed under its nearest ancestor that still exists.',
        ]
      : []),
  ]
}

/** 寫出 hook 要 `cat` 的那份檔案。回傳它的路徑；寫不出來時回 `null`（降級為沒有自我介紹）。 */
export function writeIntroFile(file: string, input: IntroInput): string | null {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: introText(input),
    },
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 原子替換：hook 可能正在讀它（多個 session 共用這份檔案）。
    const tmp = `${file}.partial`
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, file)
    return file
  } catch {
    return null
  }
}
