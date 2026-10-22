import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type CheckAnswer,
  type UpdateBackend,
  UpdateCoordinator,
  UpdateFailureError,
  type UpdateTimers,
  type UpdateView,
} from './update-coordinator'
import type { UpdateState } from './update-state'

/** A clock that runs only when told to. */
class FakeTimers implements UpdateTimers {
  time = 1_000_000
  #next = 1
  readonly #timers = new Map<number, { at: number; fn: () => void; every?: number }>()

  now(): number {
    return this.time
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++
    this.#timers.set(id, { at: this.time + ms, fn })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number)
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.#next++
    this.#timers.set(id, { at: this.time + ms, fn, every: ms })
    return id
  }
  clearInterval(handle: unknown): void {
    this.#timers.delete(handle as number)
  }
  /** Advance, firing due timers in order, letting their promises settle in between. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, timer] = due
      this.time = timer.at
      if (timer.every) timer.at += timer.every
      else this.#timers.delete(id)
      timer.fn()
      await settle()
    }
    this.time = end
    await settle()
  }
  pending(): number {
    return this.#timers.size
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const FIRST = 60_000
const PERIOD = 6 * 60 * 60 * 1000

function harness(options: {
  kind?: 'installing' | 'telling'
  answers?: Array<CheckAnswer | Error>
  download?: () => Promise<string>
  state?: UpdateState
  autoCheck?: boolean
  stateFails?: boolean
}) {
  const timers = new FakeTimers()
  const answers = [...(options.answers ?? [])]
  let checks = 0
  let downloads = 0
  let state: UpdateState = options.state ?? {}
  let autoCheck = options.autoCheck ?? true
  const notified: Array<{ kind: string; version: string }> = []
  const views: UpdateView[] = []
  const check = async (): Promise<CheckAnswer> => {
    checks++
    const next = answers.length > 1 ? answers.shift() : answers[0]
    if (next instanceof Error) throw next
    return next ?? null
  }
  const backend: UpdateBackend =
    options.kind === 'telling'
      ? { kind: 'telling', check }
      : {
          kind: 'installing',
          check,
          download: async (onProgress) => {
            downloads++
            onProgress(12.6)
            onProgress(12.9)
            onProgress(100)
            return options.download ? options.download() : '/cache/pending/Spekterm-0.2.18.AppImage'
          },
        }
  const coordinator = new UpdateCoordinator({
    backend,
    currentVersion: '0.2.17',
    state: {
      get: () => state,
      update: (patch) => {
        if (options.stateFails) throw new Error('disk full')
        const next: Record<string, unknown> = { ...state }
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete next[key]
          else next[key] = value
        }
        state = next as UpdateState
      },
    },
    autoCheck: () => autoCheck,
    notify: (event) => notified.push(event),
    onChange: (view) => views.push(view),
    timers,
    firstDelayMs: FIRST,
    intervalMs: PERIOD,
  })
  return {
    coordinator,
    timers,
    notified,
    views,
    checks: () => checks,
    downloads: () => downloads,
    state: () => state,
    setAutoCheck: (on: boolean) => {
      autoCheck = on
      coordinator.autoCheckChanged()
    },
  }
}

describe('UpdateCoordinator timing', () => {
  it('checks nothing before start, then once after the first delay, then every period', async () => {
    const h = harness({ answers: [{ latest: '0.2.17' }] })
    await h.timers.advance(10 * PERIOD)
    assert.equal(h.checks(), 0, 'no check before the restore gate')
    h.coordinator.start()
    await h.timers.advance(FIRST - 1)
    assert.equal(h.checks(), 0, 'not within the first delay')
    await h.timers.advance(1)
    assert.equal(h.checks(), 1)
    await h.timers.advance(PERIOD)
    assert.equal(h.checks(), 2)
    assert.equal(h.coordinator.view().status.kind, 'up-to-date')
  })

  it('ignores later restore-gate openings', async () => {
    const h = harness({ answers: [{ latest: '0.2.17' }] })
    h.coordinator.start()
    await h.timers.advance(FIRST / 2)
    h.coordinator.start()
    await h.timers.advance(FIRST / 2)
    assert.equal(h.checks(), 1)
  })

  it('checks on resume only when the last check is older than the period', async () => {
    const h = harness({ answers: [{ latest: '0.2.17' }] })
    h.coordinator.start()
    await h.timers.advance(FIRST)
    h.coordinator.resumed()
    await settle()
    assert.equal(h.checks(), 1, 'a recent check is enough')
    h.timers.time += PERIOD
    h.coordinator.resumed()
    await settle()
    assert.equal(h.checks(), 2)
  })

  it('stops its timers on dispose', async () => {
    const h = harness({ answers: [{ latest: '0.2.17' }] })
    h.coordinator.start()
    h.coordinator.dispose()
    assert.equal(h.timers.pending(), 0)
  })
})

describe('UpdateCoordinator switch', () => {
  it('makes no scheduled check while off, and checks after the first delay once turned on', async () => {
    const h = harness({ answers: [{ latest: '0.2.18' }], autoCheck: false })
    h.coordinator.start()
    await h.timers.advance(3 * PERIOD)
    h.coordinator.resumed()
    await settle()
    assert.equal(h.checks(), 0)
    h.setAutoCheck(true)
    await h.timers.advance(FIRST)
    assert.equal(h.checks(), 1)
  })

  it('lets Check now check and download with the switch off', async () => {
    const h = harness({ answers: [{ latest: '0.2.18' }], autoCheck: false })
    h.coordinator.start()
    await h.coordinator.checkNow()
    assert.equal(h.downloads(), 1)
    assert.deepEqual(h.coordinator.ready(), { version: '0.2.18', file: '/cache/pending/Spekterm-0.2.18.AppImage' })
  })
})

describe('UpdateCoordinator answers', () => {
  it('downloads a newer version, reports integer progress once per value, becomes ready and notifies', async () => {
    const h = harness({ answers: [{ latest: 'v0.2.18' }] })
    await h.coordinator.checkNow()
    const kinds = h.views.map((v) => (v.status.kind === 'downloading' ? `downloading ${v.status.percent}` : v.status.kind))
    assert.deepEqual(kinds, ['checking', 'downloading 0', 'downloading 12', 'downloading 100', 'ready'])
    assert.deepEqual(h.notified, [{ kind: 'ready', version: '0.2.18' }])
    assert.equal(h.coordinator.releaseUrl(), 'https://github.com/spekhq/spekterm/releases/tag/v0.2.18')
  })

  it('does not check again while ready, scheduled or by Check now', async () => {
    const h = harness({ answers: [{ latest: '0.2.18' }, { latest: '0.2.19' }] })
    h.coordinator.start()
    await h.timers.advance(FIRST)
    assert.equal(h.coordinator.view().status.kind, 'ready')
    await h.timers.advance(3 * PERIOD)
    await h.coordinator.checkNow()
    h.timers.time += PERIOD
    h.coordinator.resumed()
    await settle()
    assert.equal(h.checks(), 1)
    assert.deepEqual(h.coordinator.ready()?.version, '0.2.18')
  })

  it('treats an equal or older version, and a release without this platform file, as up to date', async () => {
    for (const answer of [{ latest: '0.2.17' }, { latest: '0.2.9' }, null]) {
      const h = harness({ answers: [answer] })
      await h.coordinator.checkNow()
      assert.equal(h.coordinator.view().status.kind, 'up-to-date', JSON.stringify(answer))
      assert.equal(h.downloads(), 0)
      assert.deepEqual(h.notified, [])
    }
  })

  it('fails a check whose answer is not a version, and downloads nothing', async () => {
    const h = harness({ answers: [{ latest: '0.2.18-beta.1' }] })
    await h.coordinator.checkNow()
    assert.deepEqual(h.coordinator.view().status, { kind: 'failed', failure: 'unexpected-answer' })
    assert.equal(h.downloads(), 0)
    assert.deepEqual(h.notified, [])
  })

  it('reports a failure quietly, records the time, and retries at the next period', async () => {
    const h = harness({ answers: [new UpdateFailureError('network', 'net::ERR_INTERNET_DISCONNECTED'), { latest: '0.2.17' }] })
    h.coordinator.start()
    await h.timers.advance(FIRST)
    assert.deepEqual(h.coordinator.view().status, { kind: 'failed', failure: 'network' })
    assert.equal(h.coordinator.view().lastCheckedAt, h.timers.time)
    assert.equal(h.state().lastCheckedAt, h.timers.time)
    assert.deepEqual(h.notified, [])
    await h.timers.advance(PERIOD)
    assert.equal(h.coordinator.view().status.kind, 'up-to-date')
  })

  it('maps an unknown error to other', async () => {
    const h = harness({ answers: [new Error('boom')] })
    await h.coordinator.checkNow()
    assert.deepEqual(h.coordinator.view().status, { kind: 'failed', failure: 'other' })
  })

  it('offers no restart after a failed download', async () => {
    const h = harness({
      answers: [{ latest: '0.2.18' }],
      download: async () => {
        throw new UpdateFailureError('checksum', 'sha512 checksum mismatch')
      },
    })
    await h.coordinator.checkNow()
    assert.deepEqual(h.coordinator.view().status, { kind: 'failed', failure: 'checksum' })
    assert.equal(h.coordinator.ready(), null)
  })

  it('shows a newer release as available on a telling build, downloading nothing', async () => {
    const h = harness({ kind: 'telling', answers: [{ latest: '0.2.18' }] })
    await h.coordinator.checkNow()
    assert.deepEqual(h.coordinator.view().status, { kind: 'available', version: '0.2.18' })
    assert.equal(h.coordinator.ready(), null)
    assert.deepEqual(h.notified, [{ kind: 'available', version: '0.2.18' }])
  })
})

describe('UpdateCoordinator notification', () => {
  it('notifies once per version, across restarts', async () => {
    const first = harness({ answers: [{ latest: '0.2.18' }] })
    await first.coordinator.checkNow()
    const again = harness({ answers: [{ latest: '0.2.18' }], state: first.state() })
    await again.coordinator.checkNow()
    assert.equal(again.coordinator.view().status.kind, 'ready')
    assert.deepEqual(first.notified.length + again.notified.length, 1)
  })

  it('still notifies once in the run when the state cannot be saved', async () => {
    const h = harness({ kind: 'telling', answers: [{ latest: '0.2.18' }], stateFails: true })
    await h.coordinator.checkNow()
    await h.coordinator.checkNow()
    assert.equal(h.notified.length, 1)
  })
})

describe('UpdateCoordinator last install', () => {
  it('shows the previous run outcome and clears it from the file', () => {
    const h = harness({ state: { installOutcome: { version: '0.2.18', ok: false, reason: 'download-missing' } } })
    assert.deepEqual(h.coordinator.view().lastInstall, { version: '0.2.18', ok: false, reason: 'download-missing' })
    assert.equal(h.state().installOutcome, undefined)
  })
})
