import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPreferencesQueue } from './preferences-queue'

interface Font {
  family: string | null
  size: number | null
}

/** A main process that answers after `delay` ms with what it applied, as `setTerminalFont` does. */
function fakeMain(): { stored: Font; setFont: (family: string | null, size: number | null, delay: number) => Promise<Font> } {
  const main = {
    stored: { family: null, size: null } as Font,
    setFont: (family: string | null, size: number | null, delay: number) =>
      new Promise<Font>((resolve) =>
        setTimeout(() => {
          main.stored = { family, size }
          resolve({ ...main.stored })
        }, delay),
      ),
  }
  return main
}

describe('preferences queue (settings-sections D3)', () => {
  it('a size write and a family write enqueued back to back both survive', async () => {
    const main = fakeMain()
    let shown: Font = { family: null, size: null }
    const queue = createPreferencesQueue<Font>(shown, (next) => (shown = next))

    const size = queue.enqueue((applied) => main.setFont(applied.family, 18, 20))
    const family = queue.enqueue((applied) => main.setFont('Fira Code', applied.size, 0))
    await Promise.all([size, family])

    assert.deepEqual(main.stored, { family: 'Fira Code', size: 18 })
    assert.deepEqual(shown, { family: 'Fira Code', size: 18 })
  })

  it('control: arguments bound when the entry is made lose the size', async () => {
    // What the queue replaces: each write built from the state at enqueue time, then run in order.
    const main = fakeMain()
    const shown: Font = { family: null, size: null }
    const queue = createPreferencesQueue<Font>(shown, () => {})

    const bound = { ...shown }
    const size = queue.enqueue(() => main.setFont(bound.family, 18, 20))
    const family = queue.enqueue(() => main.setFont('Fira Code', bound.size, 0))
    await Promise.all([size, family])

    assert.deepEqual(main.stored, { family: 'Fira Code', size: null }, 'the stale size undid the first write')
  })

  it('a rejected entry reaches its caller, changes nothing, and the next entry still runs', async () => {
    let shown = 1
    const queue = createPreferencesQueue<number>(shown, (next) => (shown = next))

    const failed = queue.enqueue(() => Promise.reject(new Error('EISDIR')))
    const next = queue.enqueue((applied) => Promise.resolve(applied + 10))

    await assert.rejects(failed, /EISDIR/)
    assert.equal(await next, 11, 'the next entry saw the value from before the failure')
    assert.equal(shown, 11)
  })

  it('reset replaces the applied value without a write', async () => {
    const queue = createPreferencesQueue<number>(0, () => {})
    queue.reset(5)
    assert.equal(await queue.enqueue((applied) => Promise.resolve(applied)), 5)
  })
})
