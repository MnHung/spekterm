import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { t } from '@shared/i18n'
import { type AskClose, type CloseGuardDeps, type ClosableWindow, guardWindowClose } from './close-guard'
import type { CloseRole, ClosePrompt, LiveSession } from './close-prompt'
import type { DirtyEntry } from './dirty-state'

/** A window whose `close()` runs the handler the way Electron does, and records whether it closed. */
function fakeWindow(): ClosableWindow & { closed: boolean; destroyed: boolean; userClose(): boolean } {
  let listener: ((event: { preventDefault(): void }) => void) | null = null
  const window = {
    closed: false,
    destroyed: false,
    webContents: { id: 1 },
    on(_event: 'close', handler: (event: { preventDefault(): void }) => void) {
      listener = handler
    },
    isDestroyed: () => window.destroyed,
    /** Emits `close`; the window closes unless the handler prevents it. Returns whether it closed. */
    userClose(): boolean {
      let prevented = false
      listener?.({ preventDefault: () => { prevented = true } })
      if (!prevented) window.closed = true
      return !prevented
    },
    close(): void {
      window.userClose()
    },
  }
  return window
}

/** A dialog answered on demand, recording every prompt it was shown. */
function onDemandDialog(): { ask: AskClose; prompts: ClosePrompt[]; answer(role: CloseRole): Promise<void> } {
  const prompts: ClosePrompt[] = []
  const waiting: ((role: CloseRole) => void)[] = []
  return {
    prompts,
    ask: (prompt) => {
      prompts.push(prompt)
      return new Promise((resolve) => waiting.push(resolve))
    },
    async answer(role) {
      waiting.shift()?.(role)
      // Let the guard's continuation run.
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

const running: LiveSession[] = [{ railLabel: 'api-server', label: 'shell 1', working: false }]
const unsaved: DirtyEntry[] = [{ folderId: 'f1', folderName: 'api-server', relPath: 'a.ts' }]

function setup(facts: { dirty?: DirtyEntry[]; sessions?: LiveSession[] } = {}) {
  const window = fakeWindow()
  const dialog = onDemandDialog()
  const quits = { finished: 0 }
  const deps: CloseGuardDeps = {
    dirty: { list: () => facts.dirty ?? [] },
    liveSessions: () => facts.sessions ?? [],
    ask: dialog.ask,
    saveAll: async () => true,
    quit: { quitting: false },
    onQuitClose: () => {
      quits.finished += 1
    },
  }
  const guarded = guardWindowClose(window, deps)
  return { window, dialog, deps, guarded, quits }
}

describe('guardWindowClose', () => {
  it('nothing to lose ⇒ the window closes without a prompt', () => {
    const { window, dialog } = setup()
    assert.equal(window.userClose(), true)
    assert.equal(dialog.prompts.length, 0)
  })

  it('a running session ⇒ held and asked; cancel keeps the window', async () => {
    const { window, dialog } = setup({ sessions: running })
    assert.equal(window.userClose(), false)
    assert.equal(dialog.prompts.length, 1)
    await dialog.answer('cancel')
    assert.equal(window.closed, false)
  })

  it('quit ⇒ the window closes', async () => {
    const { window, dialog } = setup({ sessions: running })
    window.userClose()
    await dialog.answer('quit')
    assert.equal(window.closed, true)
  })

  it('a second close while the prompt is open shows no second prompt and does not close', async () => {
    const { window, dialog } = setup({ sessions: running })
    window.userClose()
    assert.equal(window.userClose(), false)
    assert.equal(dialog.prompts.length, 1)
    await dialog.answer('cancel')
    assert.equal(window.closed, false)
  })

  it('a quit that started first (signal) closes without asking about sessions', () => {
    const { window, dialog, deps } = setup({ sessions: running })
    deps.quit.quitting = true
    assert.equal(window.userClose(), true)
    assert.equal(dialog.prompts.length, 0)
  })

  it('a quit that started first still asks about unsaved files, and without the sessions', () => {
    const { window, dialog, deps } = setup({ dirty: unsaved, sessions: running })
    deps.quit.quitting = true
    assert.equal(window.userClose(), false)
    assert.deepEqual(dialog.prompts[0].buttons.map((b) => b.role), ['saveAll', 'discard', 'cancel'])
    assert.equal(dialog.prompts[0].defaultRole, 'saveAll')
  })

  it('a signal during the open prompt, then cancel ⇒ the next close asks again', async () => {
    const { window, dialog, deps } = setup({ sessions: running })
    window.userClose()
    // before-quit, then the quit's close — held behind the open prompt.
    deps.quit.quitting = true
    assert.equal(window.userClose(), false)
    await dialog.answer('cancel')
    assert.equal(window.closed, false)
    assert.equal(window.userClose(), false)
    assert.equal(dialog.prompts.length, 2)
  })

  it('an unsaved prompt cancelled on the signal path ⇒ a later close asks about sessions', async () => {
    const { window, dialog, deps } = setup({ dirty: unsaved, sessions: running })
    deps.quit.quitting = true
    window.userClose()
    await dialog.answer('cancel')
    window.userClose()
    assert.equal(dialog.prompts.length, 2)
    assert.deepEqual(dialog.prompts[1].buttons.map((b) => b.role), ['saveAll', 'discard', 'cancel'])
    assert.equal(dialog.prompts[1].defaultRole, 'cancel')
  })

  it('an answer that arrives after the window is gone does nothing', async () => {
    const { window, dialog } = setup({ sessions: running })
    window.userClose()
    window.destroyed = true
    await assert.doesNotReject(dialog.answer('quit'))
    assert.equal(window.closed, false)
  })

  it('Save All that fails asks again; success closes', async () => {
    const { window, dialog, deps } = setup({ dirty: unsaved })
    let attempts = 0
    deps.saveAll = async () => (attempts += 1) > 1
    window.userClose()
    await dialog.answer('saveAll')
    assert.equal(dialog.prompts.length, 2)
    assert.equal(window.closed, false)
    await dialog.answer('saveAll')
    assert.equal(window.closed, true)
  })

  describe('a close that belongs to a quit finishes the quit', () => {
    it('the Quit item with nothing to ask closes and finishes the quit', () => {
      const { window, dialog, guarded, quits } = setup()
      guarded.closeForQuit()
      assert.equal(window.closed, true)
      assert.equal(dialog.prompts.length, 0)
      assert.equal(quits.finished, 1)
    })

    it('the Quit item asks about running sessions like a close; confirming finishes the quit', async () => {
      const { window, dialog, guarded, quits } = setup({ sessions: running })
      guarded.closeForQuit()
      assert.equal(window.closed, false)
      assert.match(dialog.prompts[0].detail, /shell 1/)
      await dialog.answer('quit')
      assert.equal(window.closed, true)
      assert.equal(quits.finished, 1)
    })

    it('a cancelled Quit leaves nothing behind: a later confirmed close does not quit', async () => {
      const { window, dialog, guarded, quits } = setup({ sessions: running })
      guarded.closeForQuit()
      await dialog.answer('cancel')
      assert.equal(window.closed, false)
      window.userClose()
      await dialog.answer('quit')
      assert.equal(window.closed, true)
      assert.equal(quits.finished, 0)
    })

    it('an OS quit whose unsaved changes are answered finishes the quit', async () => {
      const { window, dialog, deps, quits } = setup({ dirty: unsaved, sessions: running })
      deps.quit.quitting = true
      assert.equal(window.userClose(), false)
      assert.doesNotMatch(dialog.prompts[0].detail, /shell 1/)
      await dialog.answer('discard')
      assert.equal(window.closed, true)
      assert.equal(quits.finished, 1)
    })

    it('a quit during the open prompt makes it a quit: answering close finishes it', async () => {
      const { window, dialog, guarded, quits } = setup({ sessions: running })
      window.userClose()
      let closes = 0
      const close = window.close
      window.close = () => {
        closes += 1
        close()
      }
      guarded.closeForQuit()
      // The open question is not disturbed: no second close reaches the window (on macOS that would end
      // the sheet as if it had been answered).
      assert.equal(closes, 0)
      window.close = close
      assert.equal(dialog.prompts.length, 1)
      await dialog.answer('quit')
      assert.equal(window.closed, true)
      assert.equal(quits.finished, 1)
    })

    it('a quit during the open prompt, then cancel: a later confirmed close does not quit', async () => {
      const { window, dialog, guarded, quits } = setup({ sessions: running })
      window.userClose()
      guarded.closeForQuit()
      await dialog.answer('cancel')
      window.userClose()
      await dialog.answer('quit')
      assert.equal(window.closed, true)
      assert.equal(quits.finished, 0)
    })

    it('a plain close with nothing to ask does not quit', () => {
      const { window, quits } = setup()
      window.userClose()
      assert.equal(window.closed, true)
      assert.equal(quits.finished, 0)
    })
  })
})

describe('guardWindowClose: restart to update and the close origin', () => {
  function withOrigins(facts: { dirty?: DirtyEntry[]; sessions?: LiveSession[] } = {}) {
    const harness = setup(facts)
    const origins: string[] = []
    harness.deps.onAllowedClose = (origin) => origins.push(origin)
    return { ...harness, origins }
  }

  it('nothing to ask ⇒ the restart closes at once, as a quit, with origin restart', () => {
    const { window, dialog, guarded, quits, origins } = withOrigins()
    assert.equal(guarded.closeForRestart(), true)
    assert.equal(window.closed, true)
    assert.equal(dialog.prompts.length, 0)
    assert.equal(quits.finished, 1)
    assert.deepEqual(origins, ['restart'])
  })

  it('a running session ⇒ asked in restart words; cancel keeps everything and records nothing', async () => {
    const { window, dialog, guarded, quits, origins } = withOrigins({ sessions: running })
    guarded.closeForRestart()
    assert.equal(dialog.prompts[0].buttons[0].label, t('closeConfirm.restart'))
    assert.equal(dialog.prompts[0].defaultRole, 'cancel')
    await dialog.answer('cancel')
    assert.equal(window.closed, false)
    assert.equal(quits.finished, 0)
    assert.deepEqual(origins, [])
  })

  it('a cancelled restart leaves no intent: a later ✕ asks as a plain close and records user', async () => {
    const { window, dialog, guarded, origins } = withOrigins({ sessions: running })
    guarded.closeForRestart()
    await dialog.answer('cancel')
    window.userClose()
    assert.equal(dialog.prompts[1].buttons[0].label, t('closeConfirm.quit'))
    await dialog.answer('quit')
    assert.equal(window.closed, true)
    assert.deepEqual(origins, ['user'])
  })

  it('confirming the restart closes the window as a quit with origin restart', async () => {
    const { window, dialog, guarded, quits, origins } = withOrigins({ sessions: running })
    guarded.closeForRestart()
    await dialog.answer('quit')
    assert.equal(window.closed, true)
    assert.equal(quits.finished, 1)
    assert.deepEqual(origins, ['restart'])
  })

  it('a restart requested while a close question is open does nothing', async () => {
    const { window, dialog, guarded, origins } = withOrigins({ sessions: running })
    window.userClose()
    assert.equal(guarded.closeForRestart(), false)
    assert.equal(dialog.prompts.length, 1)
    await dialog.answer('quit')
    assert.deepEqual(origins, ['user'])
  })

  it('a plain close with nothing to ask records user', () => {
    const { window, origins } = withOrigins()
    window.userClose()
    assert.deepEqual(origins, ['user'])
  })

  it('a close that is part of a signal quit records signal', () => {
    const { window, deps, origins } = withOrigins({ sessions: running })
    deps.quit.quitting = true
    window.userClose()
    assert.equal(window.closed, true)
    assert.deepEqual(origins, ['signal'])
  })

  it('a quit arriving while the user is asked does not turn the answer into a signal', async () => {
    const { window, dialog, deps, origins } = withOrigins({ sessions: running })
    window.userClose()
    deps.quit.quitting = true
    window.userClose()
    await dialog.answer('quit')
    assert.deepEqual(origins, ['user'])
  })
})
