import assert from 'node:assert/strict'
import test from 'node:test'
import { RendererRequests } from './remote-requests'

const action = { kind: 'create', folderId: 'f1', target: 'claude' } as const

test('a reply from the renderer that was asked resolves the request; another renderer cannot answer', async () => {
  const requests = new RendererRequests(1_000)
  let sent = ''
  const pending = requests.request(1, (id) => (sent = id), action)
  requests.reply(2, sent, { ok: true, sessionId: 'forged' })
  requests.reply(1, sent, { ok: true, sessionId: 's1' })
  assert.deepEqual(await pending, { ok: true, sessionId: 's1' })
})

test('no answer within the time is a timeout', async () => {
  const requests = new RendererRequests(20)
  assert.deepEqual(await requests.request(1, () => undefined, action), {
    ok: false,
    code: 'TIMEOUT',
    message: 'the desktop did not answer in time',
  })
})

test('a renderer that goes away answers NO_WINDOW; a malformed reply is a failure', async () => {
  const requests = new RendererRequests(1_000)
  const gone = requests.request(1, () => undefined, action)
  requests.rendererGone(1)
  assert.equal((await gone).ok === false && (await gone as { code: string }).code, 'NO_WINDOW')
  let sent = ''
  const malformed = requests.request(1, (id) => (sent = id), action)
  requests.reply(1, sent, { ok: 'yes' })
  assert.deepEqual(await malformed, { ok: false, code: 'CREATE_FAILED', message: 'malformed reply' })
})
