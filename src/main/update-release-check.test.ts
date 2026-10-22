import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { UpdateFailureError } from './update-coordinator'
import { LATEST_RELEASE_API, createTellingBackend } from './update-release-check'

function answering(status: number, body: unknown, seen?: Array<{ url: string; init: RequestInit }>) {
  return createTellingBackend({
    request: async (url, init) => {
      seen?.push({ url, init })
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    },
  })
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof UpdateFailureError, String(error))
    return error.failure
  }
  assert.fail('the check did not fail')
}

describe('createTellingBackend', () => {
  it('asks the latest-release endpoint and keeps only the tag', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const backend = answering(
      200,
      { tag_name: 'v0.2.18', name: 'Click here', body: 'notes', html_url: 'https://evil.example/' },
      seen,
    )
    assert.deepEqual(await backend.check(), { latest: 'v0.2.18' })
    assert.equal(seen[0].url, LATEST_RELEASE_API)
    assert.equal(new Headers(seen[0].init.headers).get('accept'), 'application/vnd.github+json')
    assert.ok(seen[0].init.signal, 'a timeout is set')
  })

  it('passes a malformed tag on, for the coordinator to fail', async () => {
    assert.deepEqual(await answering(200, { tag_name: 'nightly' }).check(), { latest: 'nightly' })
  })

  it('reads no release as nothing newer', async () => {
    assert.equal(await answering(404, { message: 'Not Found' }).check(), null)
  })

  it('maps failures', async () => {
    assert.equal(await failure(answering(403, {}).check()), 'rate-limited')
    assert.equal(await failure(answering(429, {}).check()), 'rate-limited')
    assert.equal(await failure(answering(502, {}).check()), 'other')
    assert.equal(await failure(answering(200, '<html>').check()), 'unexpected-answer')
    assert.equal(await failure(answering(200, { name: 'x' }).check()), 'unexpected-answer')
    const offline = createTellingBackend({
      request: async () => {
        throw new TypeError('net::ERR_INTERNET_DISCONNECTED')
      },
    })
    assert.equal(await failure(offline.check()), 'network')
  })

  it('times out', async () => {
    const hanging = createTellingBackend({
      timeoutMs: 20,
      request: (_url, init) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    })
    // `AbortSignal.timeout` does not hold the event loop; this timer does, until the check has failed.
    const hold = setTimeout(() => {}, 5000)
    try {
      assert.equal(await failure(hanging.check()), 'network')
    } finally {
      clearTimeout(hold)
    }
  })
})
