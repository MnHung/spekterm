import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { t } from '@shared/i18n'
import { type LiveSession, MAX_LABEL, MAX_LISTED, closePrompt } from './close-prompt'

const file = { folderId: 'f1', folderName: 'api-server', relPath: 'src/a.ts' }
const shell = (label: string, working: boolean | null = false): LiveSession => ({
  railLabel: 'api-server',
  label,
  working,
})

const roles = (prompt: ReturnType<typeof closePrompt>) => prompt?.buttons.map((button) => button.role)

describe('closePrompt', () => {
  it('nothing unsaved and nothing running ⇒ no prompt', () => {
    assert.equal(closePrompt({ dirty: [], sessions: [] }), null)
  })

  it('unsaved files only ⇒ the unsaved-changes dialog as before (Save All is the default)', () => {
    const prompt = closePrompt({ dirty: [file], sessions: [] })
    assert.deepEqual(roles(prompt), ['saveAll', 'discard', 'cancel'])
    assert.equal(prompt?.defaultRole, 'saveAll')
    assert.equal(prompt?.cancelRole, 'cancel')
    assert.equal(prompt?.message, t('unsaved.message', { count: 1 }))
    assert.equal(prompt?.detail, 'api-server/src/a.ts')
  })

  it('running sessions only ⇒ quit or cancel, cancel is the default and the cancel answer', () => {
    const prompt = closePrompt({ dirty: [], sessions: [shell('shell 1')] })
    assert.deepEqual(roles(prompt), ['quit', 'cancel'])
    assert.equal(prompt?.defaultRole, 'cancel')
    assert.equal(prompt?.cancelRole, 'cancel')
    assert.equal(prompt?.message, t('closeConfirm.message', { count: 1 }))
    assert.match(prompt?.detail ?? '', /api-server · shell 1/)
    assert.ok(prompt?.detail.endsWith(t('closeConfirm.consequence')), prompt?.detail)
  })

  it('both ⇒ one dialog listing files and sessions, cancel is the default', () => {
    const prompt = closePrompt({ dirty: [file], sessions: [shell('shell 1')] })
    assert.deepEqual(roles(prompt), ['saveAll', 'discard', 'cancel'])
    assert.equal(prompt?.defaultRole, 'cancel')
    assert.equal(prompt?.cancelRole, 'cancel')
    assert.equal(prompt?.buttons[0].label, t('closeConfirm.saveAllAndQuit'))
    assert.match(prompt?.detail ?? '', /api-server\/src\/a\.ts/)
    assert.match(prompt?.detail ?? '', /api-server · shell 1/)
  })

  it('the default never ends a running session', () => {
    for (const dirty of [[], [file]]) {
      const prompt = closePrompt({ dirty, sessions: [shell('shell 1')] })
      assert.equal(prompt?.defaultRole, 'cancel', `dirty=${dirty.length}`)
    }
  })

  it('working sessions are listed first and marked; unknown ones carry no mark', () => {
    const prompt = closePrompt({
      dirty: [],
      sessions: [shell('idle', false), shell('unknown', null), shell('busy', true)],
    })
    const lines = (prompt?.detail ?? '').split('\n')
    assert.equal(lines[0], t('closeConfirm.lineWorking', { item: 'api-server', label: 'busy' }))
    assert.equal(lines[1], t('closeConfirm.line', { item: 'api-server', label: 'idle' }))
    assert.equal(lines[2], t('closeConfirm.line', { item: 'api-server', label: 'unknown' }))
  })

  it(`lists at most ${MAX_LISTED} sessions, then how many more`, () => {
    const sessions = Array.from({ length: MAX_LISTED + 3 }, (_, i) => shell(`shell ${i + 1}`))
    const lines = (closePrompt({ dirty: [], sessions })?.detail ?? '').split('\n')
    assert.equal(lines[MAX_LISTED - 1], t('closeConfirm.line', { item: 'api-server', label: `shell ${MAX_LISTED}` }))
    assert.equal(lines[MAX_LISTED], t('closeConfirm.more', { count: 3 }))
  })

  it(`cuts a label to ${MAX_LABEL} characters`, () => {
    const long = 'x'.repeat(MAX_LABEL * 2)
    const line = (closePrompt({ dirty: [], sessions: [shell(long)] })?.detail ?? '').split('\n')[0]
    const label = line.split(' · ')[1]
    assert.equal(label.length, MAX_LABEL)
    assert.ok(label.endsWith('…'))
  })

  describe('the dialog is true on the platform it runs on', () => {
    it('where a pty\'s directory cannot be read, shells restart in their folder', () => {
      const prompt = closePrompt({ dirty: [], sessions: [shell('shell 1')], shellsRestartIn: 'folder' })
      assert.ok(prompt?.detail.endsWith(t('closeConfirm.consequenceFolder')), prompt?.detail)
      assert.doesNotMatch(prompt?.detail ?? '', /last directory/)
    })

    it('a close that leaves the application running speaks of the window, and its buttons close', () => {
      const prompt = closePrompt({
        dirty: [],
        sessions: [shell('shell 1')],
        closesApp: false,
        shellsRestartIn: 'folder',
      })
      assert.ok(prompt?.detail.endsWith(t('closeConfirm.consequenceWindowFolder')), prompt?.detail)
      assert.doesNotMatch(prompt?.detail ?? '', /Closing spekterm/)
      assert.deepEqual(
        prompt?.buttons.map((button) => button.label),
        [t('closeConfirm.closeWindow'), t('closeConfirm.cancel')],
      )
    })

    it('with unsaved files too, the window wording carries to both answers that close', () => {
      const prompt = closePrompt({ dirty: [file], sessions: [shell('shell 1')], closesApp: false })
      assert.deepEqual(
        prompt?.buttons.map((button) => button.label),
        [t('closeConfirm.saveAllAndClose'), t('closeConfirm.closeWithoutSaving'), t('closeConfirm.cancel')],
      )
    })
  })
})


describe('closePrompt for a restart to update', () => {
  it('nothing to ask ⇒ no prompt, the restart goes ahead', () => {
    assert.equal(closePrompt({ dirty: [], sessions: [], restart: true }), null)
  })

  it('running sessions ⇒ restart or cancel, cancel the default, the restart consequence', () => {
    const prompt = closePrompt({ dirty: [], sessions: [shell('shell 1')], restart: true })
    assert.deepEqual(roles(prompt), ['quit', 'cancel'])
    assert.equal(prompt?.buttons[0].label, t('closeConfirm.restart'))
    assert.equal(prompt?.defaultRole, 'cancel')
    assert.equal(prompt?.cancelRole, 'cancel')
    assert.ok(prompt?.detail.endsWith(t('closeConfirm.consequenceRestart')), prompt?.detail)
  })

  it('both ⇒ the save answers are worded for a restart, cancel the default', () => {
    const prompt = closePrompt({ dirty: [file], sessions: [shell('shell 1')], restart: true })
    assert.deepEqual(
      prompt?.buttons.map((button) => button.label),
      [t('closeConfirm.saveAllAndRestart'), t('closeConfirm.restartWithoutSaving'), t('closeConfirm.cancel')],
    )
    assert.equal(prompt?.defaultRole, 'cancel')
  })

  it('unsaved files only ⇒ the save answers are worded for a restart', () => {
    const prompt = closePrompt({ dirty: [file], sessions: [], restart: true })
    assert.deepEqual(roles(prompt), ['saveAll', 'discard', 'cancel'])
    assert.equal(prompt?.buttons[0].label, t('closeConfirm.saveAllAndRestart'))
    assert.equal(prompt?.buttons[1].label, t('closeConfirm.restartWithoutSaving'))
  })

  it('shells restarting in their folder are said so', () => {
    const prompt = closePrompt({ dirty: [], sessions: [shell('shell 1')], restart: true, shellsRestartIn: 'folder' })
    assert.ok(prompt?.detail.endsWith(t('closeConfirm.consequenceRestartFolder')), prompt?.detail)
  })
})
