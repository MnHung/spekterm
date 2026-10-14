/**
 * The stub agent's `transcriptFixture` option (website screenshots): the fixture lands, byte for byte, at
 * the path the conversation view reads — derived from the cwd and the session id the product passes — in
 * place of the stub's own greeting, on a fresh start and on `--resume`.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import pty from 'node-pty'
import { pollFor } from './lib/instrument.mjs'
import { makeStubAgent } from './lib/stub-agent.mjs'

const temps = []
const mkTemp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
test.after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

for (const flag of ['--session-id', '--resume']) {
  test(`a transcript fixture replaces the greeting (${flag})`, async () => {
    const configDir = mkTemp('stub-config-')
    const cwd = mkTemp('stub-cwd-')
    const fixture = join(mkTemp('stub-fixture-'), 'transcript.jsonl')
    writeFileSync(fixture, '{"type":"user","uuid":"u1","message":{"role":"user","content":"hello"}}\n')
    const stub = makeStubAgent(mkTemp, configDir, { transcriptFixture: fixture })

    const child = pty.spawn(join(stub.bin, 'claude'), [flag, 'X'], { cwd, cols: 80, rows: 24, env: process.env })
    try {
      const transcript = join(configDir, 'projects', cwd.replace(/[^0-9A-Za-z]/g, '-'), 'X.jsonl')
      await pollFor({
        read: () => (existsSync(transcript) ? readFileSync(transcript, 'utf8') : ''),
        settled: (text) => text.length > 0,
        timeoutMs: 5_000,
        label: 'the stub writes its transcript',
      })
      assert.equal(readFileSync(transcript, 'utf8'), readFileSync(fixture, 'utf8'))
    } finally {
      child.kill()
    }
  })
}

/**
 * The block receipt (`remote-protocol`'s split send): text and a submit key written 500 ms apart arrive as
 * two blocks, the second one at least 400 ms after the first; written together they arrive as one. Every
 * user record the stub writes has its own `uuid`, so a resume point names exactly one record.
 */
test('input arrives in timed blocks, and each user record has its own uuid', async () => {
  const configDir = mkTemp('stub-config-')
  const cwd = mkTemp('stub-cwd-')
  const stub = makeStubAgent(mkTemp, configDir)
  const child = pty.spawn(join(stub.bin, 'claude'), ['--session-id', 'B'], { cwd, cols: 80, rows: 24, env: process.env })
  try {
    await pollFor({ read: () => stub.ready(), settled: Boolean, timeoutMs: 5_000, label: 'the stub is ready' })
    child.write('first line')
    await new Promise((resolve) => setTimeout(resolve, 500))
    child.write('\r')
    await pollFor({
      read: () => stub.sessionBlocks('B'),
      // The tty's line discipline turns `\r` into `\n` (ICRNL) before the stub reads it.
      settled: (blocks) => blocks.some((block) => block.text.includes('\n')),
      timeoutMs: 5_000,
      label: 'the submit key arrives',
    })
    child.write('second line\r')
    const transcript = join(configDir, 'projects', cwd.replace(/[^0-9A-Za-z]/g, '-'), 'B.jsonl')
    const users = await pollFor({
      read: () =>
        (existsSync(transcript) ? readFileSync(transcript, 'utf8') : '')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((record) => record.type === 'user'),
      settled: (records) => records.length === 2,
      timeoutMs: 5_000,
      label: 'two user records',
    })
    const blocks = stub.sessionBlocks('B')
    const submit = blocks.findIndex((block) => block.text === '\n')
    assert.ok(submit > 0, `the submit key is a block of its own: ${JSON.stringify(blocks)}`)
    assert.ok(blocks[submit].atMs - blocks[submit - 1].atMs >= 400, 'it arrived at least 400 ms after the text')
    assert.ok(blocks.some((block) => block.text === 'second line\n'), 'text and key written together are one block')
    assert.notEqual(users[0].uuid, users[1].uuid)
    assert.equal(stub.bytes(), 'first line\nsecond line\n', 'the byte receipt is unchanged')
  } finally {
    child.kill()
  }
})
