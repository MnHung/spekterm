import { t } from '@shared/i18n'
import type { DirtyEntry } from './dirty-state'

/**
 * What closing the window would end, and the one dialog that asks about it (`workspace-app-shell`,
 * design C1, C4, C5 of `maximize-panel-and-confirm-close`).
 *
 * **Pure**: facts in, a prompt out. The guard (`close-guard.ts`) decides *when* to ask; this module
 * decides *what* the question is. Keeping them apart is what lets the unit tests cover every
 * combination of unsaved files and running sessions without a window.
 */

/** An answer, independent of the button's position and language. */
export type CloseRole = 'saveAll' | 'discard' | 'quit' | 'cancel'

/** A session that holds a running process. */
export interface LiveSession {
  /** The rail item's name (a folder's name, or the global item's). */
  railLabel: string
  /** The session's name as its tab derives it. */
  label: string
  /** `true` working, `false` idle, `null` not known — a `null` is shown without a mark. */
  working: boolean | null
}

export interface CloseFacts {
  dirty: readonly DirtyEntry[]
  /** In rail order. Empty when the close is part of a quit that did not start with it (C3). */
  sessions: readonly LiveSession[]
  /**
   * Whether this close ends the application. `false` only on macOS for a plain close of the window, which
   * leaves the application running — the dialog then says "the window", not "spekterm", and its buttons
   * close rather than quit (`workspace-app-shell`: the dialog is true on the platform it runs on).
   * Default `true`.
   */
  closesApp?: boolean
  /**
   * Where a shell restarts when woken: its last directory where the application can read a pty's working
   * directory, its folder elsewhere (macOS). Default `'lastDirectory'`.
   */
  shellsRestartIn?: 'lastDirectory' | 'folder'
  /**
   * The close is the first step of "Restart to update" (`app-update`): the same questions, worded for a restart
   * — the app starts again with the new version. Only on Linux, where closing the window ends the application.
   */
  restart?: boolean
}

/** The consequence sentence for what closes and where shells come back. */
function consequenceKey(facts: CloseFacts) {
  if (facts.restart) return facts.shellsRestartIn === 'folder' ? 'closeConfirm.consequenceRestartFolder' : 'closeConfirm.consequenceRestart'
  const window = facts.closesApp === false
  const folder = facts.shellsRestartIn === 'folder'
  if (window) return folder ? 'closeConfirm.consequenceWindowFolder' : 'closeConfirm.consequenceWindow'
  return folder ? 'closeConfirm.consequenceFolder' : 'closeConfirm.consequence'
}

export interface ClosePrompt {
  message: string
  detail: string
  buttons: { role: CloseRole; label: string }[]
  defaultRole: CloseRole
  cancelRole: CloseRole
}

/** How many entries a list shows before "…and N more". A list that does not fit helps no decision. */
export const MAX_LISTED = 10

/** Labels come from pty titles; one long title must not push the rest of the dialog off screen. */
export const MAX_LABEL = 80

function cut(text: string): string {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text
}

function describeFiles(entries: readonly DirtyEntry[]): string {
  const listed = entries
    .slice(0, MAX_LISTED)
    .map((entry) => `${entry.folderName}/${entry.relPath}`)
    .join('\n')
  const remaining = entries.length - MAX_LISTED
  return remaining > 0 ? `${listed}\n${t('unsaved.more', { count: remaining })}` : listed
}

/** Working sessions first; otherwise the order given (a stable sort keeps rail order). */
export function orderSessions(sessions: readonly LiveSession[]): LiveSession[] {
  return [...sessions].sort((a, b) => Number(b.working === true) - Number(a.working === true))
}

function describeSessions(facts: CloseFacts): string {
  const ordered = orderSessions(facts.sessions)
  const lines = ordered.slice(0, MAX_LISTED).map((session) => {
    const values = { item: cut(session.railLabel), label: cut(session.label) }
    return session.working === true ? t('closeConfirm.lineWorking', values) : t('closeConfirm.line', values)
  })
  const remaining = ordered.length - MAX_LISTED
  if (remaining > 0) lines.push(t('closeConfirm.more', { count: remaining }))
  return `${lines.join('\n')}\n\n${t(consequenceKey(facts))}`
}

/** The dialog for these facts, or `null` when closing ends nothing and loses nothing. */
export function closePrompt(facts: CloseFacts): ClosePrompt | null {
  const files = facts.dirty.length
  const sessions = facts.sessions.length
  if (files === 0 && sessions === 0) return null
  const closesApp = facts.closesApp !== false
  const restart = facts.restart === true

  if (sessions === 0) {
    // Unchanged from the unsaved-changes dialog this replaces: no session runs, so saving all and
    // closing ends nothing but the window.
    return {
      message: t('unsaved.message', { count: files }),
      detail: describeFiles(facts.dirty),
      buttons: [
        { role: 'saveAll', label: t(restart ? 'closeConfirm.saveAllAndRestart' : 'unsaved.saveAll') },
        { role: 'discard', label: t(restart ? 'closeConfirm.restartWithoutSaving' : 'unsaved.discard') },
        { role: 'cancel', label: t('unsaved.cancel') },
      ],
      defaultRole: 'saveAll',
      cancelRole: 'cancel',
    }
  }

  if (files === 0) {
    return {
      message: t('closeConfirm.message', { count: sessions }),
      detail: describeSessions(facts),
      buttons: [
        { role: 'quit', label: t(restart ? 'closeConfirm.restart' : closesApp ? 'closeConfirm.quit' : 'closeConfirm.closeWindow') },
        { role: 'cancel', label: t('closeConfirm.cancel') },
      ],
      defaultRole: 'cancel',
      cancelRole: 'cancel',
    }
  }

  // Both: one dialog (C1). **Cancel is the default** — either other answer ends every session (C4).
  return {
    message: t('unsaved.message', { count: files }),
    detail: `${describeFiles(facts.dirty)}\n\n${t('closeConfirm.message', { count: sessions })}\n${describeSessions(facts)}`,
    buttons: [
      {
        role: 'saveAll',
        label: t(restart ? 'closeConfirm.saveAllAndRestart' : closesApp ? 'closeConfirm.saveAllAndQuit' : 'closeConfirm.saveAllAndClose'),
      },
      {
        role: 'discard',
        label: t(restart ? 'closeConfirm.restartWithoutSaving' : closesApp ? 'closeConfirm.quitWithoutSaving' : 'closeConfirm.closeWithoutSaving'),
      },
      { role: 'cancel', label: t('closeConfirm.cancel') },
    ],
    defaultRole: 'cancel',
    cancelRole: 'cancel',
  }
}
