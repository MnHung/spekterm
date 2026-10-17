import { t } from '@shared/i18n'
import type { SpawnTarget } from '../types'
import type { SessionState } from './sessions'
import { preferredTitle } from '@shared/lineage/label'
import type { Attention, RowState } from '@shared/wait/attention'

const SPAWN_LABEL: Record<SpawnTarget, string> = {
  claude: 'claude',
  shell: 'shell',
}

/** 分頁列與 rail 都是窄的橫向空間，過長的標題必須讓位。 */
const MAX_LABEL = 28

/**
 * session 的**完整**身分，供 tooltip 使用。三層優先序：
 *
 * 1. **使用者親自取的名字** —— 他**永久**接管了命名權，pty 其後宣告的標題一律靜默地不予呈現
 *    （不覆蓋、不確認、不提示）。交還命名權的唯一路徑是把名字清空。
 * 1½. **交接的標題**（由交接建立的 session，`handoff-brief`）—— 前兩層與它的取用順序在
 *    `@shared/lineage/label` 的 `preferredTitle`，三個計算點共用。
 * 2. **pty 以 OSC 序列宣告的標題** —— 跑在裡面的程式最清楚自己是誰（`claude` 會主動送這個，
 *    那正是終端模擬器的分頁會自動改名的機制）。**僅 `claude` 目標**：login shell 宣告的是它
 *    預設的 prompt 標題（`使用者@主機:/路徑`），對使用者零識別意義，且會讓分頁寬度在眼前
 *    突變 —— 它在 `sessions.tsx` 的 `setTitle()` 就被丟棄，`title` 因此恆為 `undefined`。
 * 3. **本地流水號** —— 兩者都沒有時的退路（login shell 恆走這條）。
 */
export function sessionTitle(session: SessionState): string {
  return preferredTitle(session) ?? `${SPAWN_LABEL[session.spawnTarget]} ${session.ordinal}`
}

/** 呈現用的標籤：截斷是呈現上的取捨，完整標題仍可自 tooltip 取得（見 `sessionTitle`）。 */
export function sessionLabel(session: SessionState): string {
  const full = sessionTitle(session)
  return full.length > MAX_LABEL ? `${full.slice(0, MAX_LABEL - 1)}…` : full
}

/**
 * The words for a running agent session's attention (`session-wait-indicator`). `unknown` has none: an unknown state
 * cannot claim to be anything, so the title stays today's "Running".
 */
const ATTENTION_KEY = {
  choice: 'sessions.attentionChoice',
  waiting: 'sessions.attentionWaiting',
  working: 'sessions.attentionWorking',
  idle: 'sessions.attentionIdle',
} as const

export function attentionWords(attention: Attention): string | null {
  return attention === 'unknown' ? null : t(ATTENTION_KEY[attention])
}

/** `attention` is the main process's projection for this session; `undefined` for a shell or a session not running. */
export function statusTitle(session: SessionState, attention?: Attention): string {
  if (session.status === 'running') {
    const words = attention && session.spawnTarget === 'claude' ? attentionWords(attention) : null
    return words ? t('sessions.statusRunningWith', { state: words }) : t('sessions.statusRunning')
  }
  // **休眠不是結束。** 少了這一條，重建出來的 session 會被說成「已結束（代碼 0）」——
  // 而那是使用者重開 app 後看到的第一個畫面，等於在告訴他「你的 session 都死了」。
  if (session.status === 'dormant') return t('sessions.statusDormant')
  return session.exitCode === 0
    ? t('sessions.statusExited')
    : t('sessions.statusExitedWithCode', { code: session.exitCode ?? 0 })
}

/** What the rail item dot ranks for one session (`mostUrgent`). */
export function rowStateOf(session: SessionState, attention?: Attention): RowState {
  if (session.status === 'running') return attention && session.spawnTarget === 'claude' ? attention : 'running'
  if (session.status === 'dormant') return 'dormant'
  return session.exitCode === 0 ? 'ended' : 'error'
}

/**
 * The look of each state (`session-wait-indicator` design D5, after the mockup's `.sdot`):
 *
 * - **choice / waiting** — amber, glowing, pulsing (`.sdot.wait`): the state the user scans for. The pulse stops
 *   under reduced motion;
 * - **working** — green with a glow (`.sdot.run`);
 * - **running** — the plain green of an unknown state (a shell, or no events): it cannot claim to be working;
 * - **idle** — a green ring. **Not the mockup's grey**: grey is the hibernated dot here, and "alive, resting" must not
 *   read as "asleep";
 * - **dormant / ended** — grey; **ended with an error** — danger, so a failed start ("claude not found") shows.
 *   Hibernation is never danger: a restored session must not look dead.
 */
const TONE: Record<RowState, string> = {
  choice: 'bg-accent shadow-[0_0_7px_rgba(245,158,11,0.7)] motion-safe:animate-pulse',
  waiting: 'bg-accent shadow-[0_0_7px_rgba(245,158,11,0.7)] motion-safe:animate-pulse',
  working: 'bg-green shadow-[0_0_6px_rgba(52,211,153,0.55)]',
  running: 'bg-emerald-400',
  unknown: 'bg-emerald-400',
  idle: 'border border-green',
  dormant: 'bg-ink-faint',
  ended: 'bg-ink-faint',
  error: 'bg-danger',
}

export function StateDot({ state }: { state: RowState }): React.JSX.Element {
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[state]}`} />
}

export function StatusDot({ session, attention }: { session: SessionState; attention?: Attention }): React.JSX.Element {
  return <StateDot state={rowStateOf(session, attention)} />
}

/** The words for a rail item's most urgent state (its row's title). */
export function rowStateWords(state: RowState): string {
  switch (state) {
    case 'error':
      return t('rail.stateError')
    case 'dormant':
      return t('rail.stateHibernated')
    case 'ended':
      return t('sessions.statusExited')
    case 'running':
    case 'unknown':
      return t('sessions.statusRunning')
    default:
      return attentionWords(state) ?? t('sessions.statusRunning')
  }
}
