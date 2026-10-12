import { type CloseRole, type ClosePrompt, type LiveSession, closePrompt } from './close-prompt'
import type { DirtyEntry } from './dirty-state'

/**
 * The window's one `close` handler (`workspace-app-shell`, design C1 and C3 of
 * `maximize-panel-and-confirm-close`).
 *
 * It replaces the unsaved-changes guard rather than sitting beside it: two handlers on the same
 * event would each `preventDefault()` and each show a dialog.
 *
 * **No Electron import.** The window, the dialog and the save round trip are injected, so the
 * re-entrancy and quit-flag rules can be unit-tested with a fake window (`close-guard.test.ts`).
 */

/** The part of a `BrowserWindow` the guard uses. */
export interface ClosableWindow {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
  close(): void
  isDestroyed(): boolean
  readonly webContents: { readonly id: number }
}

/** Shows a prompt and resolves with the chosen role. */
export type AskClose = (prompt: ClosePrompt) => Promise<CloseRole>

/**
 * Set on `before-quit` by `index.ts`.
 *
 * A close the user starts emits `close` **before** any `before-quit`; a quit started by a signal or
 * the OS emits `before-quit` first (measured with Electron 43.5.0). So `quitting === true` inside
 * the `close` handler means "this close is part of a quit that did not start with closing the
 * window" — the session question is skipped (C3).
 */
export interface QuitState {
  quitting: boolean
}

export interface CloseGuardDeps {
  dirty: { list(contentsId: number): DirtyEntry[] }
  /** The window's sessions that hold a pty, in rail order. Read synchronously. */
  liveSessions: (contentsId: number) => LiveSession[]
  ask: AskClose
  /** Ask the renderer to save everything; `false` on failure or timeout. */
  saveAll: () => Promise<boolean>
  quit: QuitState
  /**
   * Called, synchronously, when a close that **belongs to a quit** is about to go ahead. The caller
   * finishes the quit once the window has closed (`index.ts`: `app.quit()` on `closed`).
   *
   * Needed because a quit that had to wait for an answer is no longer a quit when the answer comes:
   * Electron abandons a quit the moment a `close` is prevented. On Linux, `window-all-closed` quit the
   * application anyway; on macOS closing the window leaves the application running, and a user who chose
   * Quit would be left with an application and no window (`workspace-app-shell`, "A quit that waited for
   * an answer finishes once it is answered").
   */
  onQuitClose?: () => void
  /**
   * Whether closing the window ends the application on this platform. `false` on macOS, where the
   * application stays running with no window; the dialog then speaks of the window. Default `true`.
   */
  closeQuitsApp?: boolean
  /** Where shells restart when woken, for the dialog's wording (`ptyCwdReadable`). */
  shellsRestartIn?: 'lastDirectory' | 'folder'
}

/** What the caller can ask of a guarded window. */
export interface GuardedWindow {
  /**
   * Close the window as the first step of a quit — the macOS Quit item and `Cmd+Q`. The close takes the
   * normal path (the unsaved-changes and running-sessions questions); the quit happens only if the close
   * does. A cancelled close discards the intent: nothing is left behind that would turn a later close into
   * a quit.
   */
  closeForQuit(): void
}

export function guardWindowClose(window: ClosableWindow, deps: CloseGuardDeps): GuardedWindow {
  const contentsId = window.webContents.id
  let allowClose = false
  /** A prompt is open. Any further close waits for its answer — one question at a time. */
  let asking = false
  /** Set by `closeForQuit()` for the one `close` event it causes; read and cleared there. */
  let closeIsQuit = false
  /** The open prompt's close belongs to a quit — from the start, or upgraded by a quit while it was open. */
  let askingForQuit = false

  const factsFor = (quitting: boolean, forQuit: boolean) => ({
    dirty: deps.dirty.list(contentsId),
    sessions: quitting ? [] : deps.liveSessions(contentsId),
    closesApp: forQuit || deps.closeQuitsApp !== false,
    shellsRestartIn: deps.shellsRestartIn,
  })

  /** Whether the window may close. Save All that fails asks again rather than deciding to discard. */
  const resolve = async (first: ClosePrompt, quitting: boolean): Promise<boolean> => {
    let prompt: ClosePrompt | null = first
    while (prompt) {
      const role = await deps.ask(prompt)
      if (role === 'cancel') return false
      if (role !== 'saveAll') return true
      if (window.isDestroyed()) return false
      if (await deps.saveAll()) return true
      // Saving failed or timed out (a conflict, a renderer that does not answer). Ask again with
      // what is true now; if nothing is left to ask about, closing loses nothing.
      prompt = closePrompt(factsFor(quitting, askingForQuit))
    }
    return true
  }

  window.on('close', (event) => {
    if (allowClose) return

    const forQuit = closeIsQuit || deps.quit.quitting
    closeIsQuit = false

    // Electron cancels a quit the moment a `close` is prevented. A `quitting` flag left set after
    // that would make a later click on ✕ skip the session question — so every prevented close
    // reads the flag and clears it.
    //
    // A quit that arrives while the question is open (a signal, the quit Apple event, the Quit item)
    // shows no second question, but it does make the open one a quit: answering close finishes it.
    if (asking) {
      event.preventDefault()
      deps.quit.quitting = false
      if (forQuit) askingForQuit = true
      return
    }

    // The decision must be synchronous: `preventDefault()` only counts inside this call.
    // Only a quit that did not start with closing the window skips the session question —
    // `closeForQuit()` starts with closing it, so it asks like any close.
    const quitting = deps.quit.quitting
    const prompt = closePrompt(factsFor(quitting, forQuit))
    if (!prompt) {
      if (forQuit) deps.onQuitClose?.()
      return
    }

    event.preventDefault()
    deps.quit.quitting = false
    asking = true
    askingForQuit = forQuit

    void resolve(prompt, quitting)
      .catch((error: unknown) => {
        console.error(`[close] the close confirmation failed: ${String(error)}`)
        return false
      })
      .then((shouldClose) => {
        asking = false
        const quit = askingForQuit
        askingForQuit = false
        if (!shouldClose || window.isDestroyed()) return
        allowClose = true
        if (quit) deps.onQuitClose?.()
        window.close()
      })
  })

  return {
    closeForQuit(): void {
      if (window.isDestroyed()) return
      // **A question already open only becomes a quit; the window is not closed again.** On macOS a
      // close of a window with a sheet ends the sheet first (Electron), which the dialog reads as an
      // answer — measured: Cmd+Q during the open dialog made it vanish and nothing quit.
      if (asking) {
        askingForQuit = true
        return
      }
      // Read and cleared by the `close` handler. **Not reset after `close()` returns**: whether Electron
      // emits `close` inside that call or later is not something this module should depend on.
      closeIsQuit = true
      window.close()
    },
  }
}
