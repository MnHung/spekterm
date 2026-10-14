import assert from 'node:assert/strict'
import test from 'node:test'
import { type OutputListener, RemoteOutput } from './remote-output'

function collector(): OutputListener & { chunks: string[]; ends: string[] } {
  const chunks: string[] = []
  const ends: string[] = []
  return { chunks, ends, data: (_g, _o, chunk) => chunks.push(chunk), size: () => undefined, ended: (reason) => ends.push(reason) }
}

test('a resume inside the ring continues exactly; outside it replaces and is incomplete', () => {
  const output = new RemoteOutput(10)
  output.setEnabled(true)
  output.spawned('s')
  output.data('s', 'abcde')
  const first = output.watch('s', undefined, collector())
  assert.deepEqual(first?.snapshot, { gen: first?.snapshot.gen, offset: 5, data: 'abcde', complete: true, replacing: true })
  first?.stop()
  output.data('s', 'fgh')
  const resumed = output.watch('s', { gen: first!.snapshot.gen, offset: 5 }, collector())
  assert.equal(resumed?.snapshot.data, 'fgh')
  assert.equal(resumed?.snapshot.replacing, false)
  resumed?.stop()

  output.data('s', 'ijklmno') // 15 written, capacity 10: offsets 0–4 are gone
  const old = output.watch('s', { gen: first!.snapshot.gen, offset: 2 }, collector())
  assert.equal(old?.snapshot.data, 'fghijklmno')
  assert.equal(old?.snapshot.replacing, true)
  assert.equal(old?.snapshot.complete, false)
})

test('a position from an earlier pty replaces, and the watch of the old pty ends', () => {
  const output = new RemoteOutput()
  output.setEnabled(true)
  output.spawned('s')
  output.data('s', 'before')
  const listener = collector()
  const watch = output.watch('s', undefined, listener)
  const oldGen = watch!.snapshot.gen
  output.spawned('s')
  assert.deepEqual(listener.ends, ['restarted'])
  // Longer than the old position, so only the gen tells the old position from a new one.
  output.data('s', 'after the wake')
  const again = output.watch('s', { gen: oldGen, offset: 6 }, collector())
  assert.equal(again?.snapshot.data, 'after the wake')
  assert.equal(again?.snapshot.replacing, true)
  assert.notEqual(again?.snapshot.gen, oldGen)
})

test('no chunk is lost or repeated across a subscribe', () => {
  const output = new RemoteOutput()
  output.setEnabled(true)
  output.spawned('s')
  output.data('s', '1\n2\n')
  const listener = collector()
  const watch = output.watch('s', undefined, listener)
  output.data('s', '3\n')
  assert.equal(watch!.snapshot.data + listener.chunks.join(''), '1\n2\n3\n')
})

test('a trim never splits a surrogate pair', () => {
  const output = new RemoteOutput(4)
  output.setEnabled(true)
  output.spawned('s')
  output.data('s', 'a😀bcd') // a, high, low, b, c, d = 6 units; capacity 4 would cut after the high half
  const watch = output.watch('s', undefined, collector())
  const data = watch!.snapshot.data
  assert.equal(data, 'bcd')
  assert.ok(!/^[\udc00-\udfff]/.test(data))
})

test('nothing is buffered while off, and turning off ends watches', () => {
  const output = new RemoteOutput()
  output.spawned('s')
  output.data('s', 'unseen')
  assert.equal(output.watch('s', undefined, collector()), null)
  output.setEnabled(true)
  output.data('s', 'seen')
  const listener = collector()
  const watch = output.watch('s', undefined, listener)
  assert.equal(watch?.snapshot.data, 'seen')
  assert.equal(watch?.snapshot.complete, false, 'output before remote access was on is not held')
  output.setEnabled(false)
  assert.deepEqual(listener.ends, ['off'])
})

test('an exited session cannot be watched, and its watch ends', () => {
  const output = new RemoteOutput()
  output.setEnabled(true)
  output.spawned('s')
  const listener = collector()
  output.watch('s', undefined, listener)
  output.exited('s')
  assert.deepEqual(listener.ends, ['exited'])
  assert.equal(output.watch('s', undefined, collector()), null)
})
