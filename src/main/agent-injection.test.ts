import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { composeInjection, type InjectionContribution } from './agent-injection'

function tmpSettingsFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spekterm-injection-')), 'settings.json')
}

function readSettings(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

function hookCommands(settings: Record<string, unknown>, event: string): string[] {
  const groups = (settings.hooks as Record<string, { hooks: { command: string }[] }[]>)[event]
  return groups.flatMap((group) => group.hooks.map((hook) => hook.command))
}

test('兩個貢獻者對同一個 hook 事件各貢獻一條命令時，兩條都在', () => {
  const file = tmpSettingsFile()
  const a: InjectionContribution = { settings: {}, hooks: { SessionStart: ['cmd-a'] }, env: {} }
  const b: InjectionContribution = { settings: {}, hooks: { SessionStart: ['cmd-b'] }, env: {} }

  const injection = composeInjection(file, [a, b])

  assert.ok(injection)
  assert.deepEqual(hookCommands(readSettings(file), 'SessionStart'), ['cmd-a', 'cmd-b'])
})

test('串接的順序即貢獻的順序', () => {
  const file = tmpSettingsFile()
  composeInjection(file, [
    { settings: {}, hooks: { Stop: ['first'] }, env: {} },
    { settings: {}, hooks: { Stop: ['second'] }, env: {} },
  ])
  assert.deepEqual(hookCommands(readSettings(file), 'Stop'), ['first', 'second'])
})

test('不同事件互不干擾', () => {
  const file = tmpSettingsFile()
  composeInjection(file, [
    { settings: {}, hooks: { SessionStart: ['a'], Stop: ['b'] }, env: {} },
    { settings: {}, hooks: { SessionStart: ['c'] }, env: {} },
  ])
  const settings = readSettings(file)
  assert.deepEqual(hookCommands(settings, 'SessionStart'), ['a', 'c'])
  assert.deepEqual(hookCommands(settings, 'Stop'), ['b'])
})

test('沒有任何貢獻者用 hooks 時，設定中不出現 hooks', () => {
  const file = tmpSettingsFile()
  composeInjection(file, [{ settings: { statusLine: { type: 'command' } }, env: {} }])
  assert.equal('hooks' in readSettings(file), false)
})

test('同一個非 hook 設定項被貢獻兩次是明確的失敗，不是靜默採用其中一份', () => {
  const file = tmpSettingsFile()
  assert.throws(
    () =>
      composeInjection(file, [
        { settings: { statusLine: 'mine' }, env: {} },
        { settings: { statusLine: 'theirs' }, env: {} },
      ]),
    /statusLine/,
  )
})

test('經 settings 貢獻 hooks 被拒絕 —— 那條路徑的合併語意與 hooks 欄位相反', () => {
  const file = tmpSettingsFile()
  assert.throws(
    () => composeInjection(file, [{ settings: { hooks: { SessionStart: [] } }, env: {} }]),
    /hooks/,
  )
})

test('同名的環境變數被貢獻兩次同樣是明確的失敗', () => {
  const file = tmpSettingsFile()
  assert.throws(
    () =>
      composeInjection(file, [
        { settings: {}, env: { SPEKTERM_X: '1' } },
        { settings: {}, env: { SPEKTERM_X: '2' } },
      ]),
    /SPEKTERM_X/,
  )
})

test('全部不參與時不注入', () => {
  assert.equal(composeInjection(tmpSettingsFile(), [null, null]), null)
})

test('the attachment read rule composes with the event hooks, as a read rule and not a working directory', async () => {
  const { configureAgentEvents, prepareEventInjection } = await import('./agent-events')
  const { configureAttachments, prepareAttachmentAccess } = await import('./remote-attachments')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-'))
  configureAgentEvents(userData)
  configureAttachments(userData)
  const file = tmpSettingsFile()
  const injection = composeInjection(file, [prepareEventInjection('s1', true), prepareAttachmentAccess(true)])
  assert.ok(injection)
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
  const store = path.join(userData, 'remote-attachments')
  assert.deepEqual(settings.permissions, { allow: [`Read(/${store}/**)`] })
  assert.ok(String(settings.permissions.allow[0]).startsWith('Read(//'), 'an absolute path rule starts with //')
  assert.equal(settings.permissions.additionalDirectories, undefined)
  assert.ok(settings.hooks.PermissionRequest, 'the hooks are still there')
  assert.equal(prepareAttachmentAccess(false), null)
  fs.rmSync(userData, { recursive: true, force: true })
})
