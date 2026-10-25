import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { RemoteError } from './remote-frames'
import { IMAGE_CHUNK_LIMIT, IMAGE_LIMIT, readResultImage, ResultImageIndex } from './remote-result-images'
import {
  imageBlock,
  imageBytes,
  readImageRecord,
  requestBlobRecord,
  resultRecord,
  textBlock,
} from './result-image.testkit'
import { project, type ViewEvent } from './transcript-follow'
import { nodeTranscriptFs, type TranscriptFs } from './transcript-line-index'

const root = mkdtempSync(join(tmpdir(), 'spekterm-result-images-'))
after(() => rmSync(root, { recursive: true, force: true }))
let seq = 0
function lines(records: unknown[]): string {
  return records.map((r) => `${typeof r === 'string' ? r : JSON.stringify(r)}\n`).join('')
}
function transcript(records: unknown[]): string {
  const d = join(root, `d${++seq}`)
  mkdirSync(d)
  const file = join(d, 't.jsonl')
  writeFileSync(file, lines(records))
  return file
}
async function code(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return 'ok'
  } catch (error) {
    if (error instanceof RemoteError) return error.code
    throw error
  }
}
const WHOLE = { offset: 0, length: IMAGE_CHUNK_LIMIT }
const read = (index: ResultImageIndex, tp: string, id: string, i: number, request: { offset: number; length: number; version?: string } = WHOLE) => readResultImage(index, tp, id, i, request)
const bytesOf = (chunk: { data: string }) => Buffer.from(chunk.data, 'base64')

/** An assistant record calling a tool, so the id exists in the transcript as a call. */
function toolCall(id: string): Record<string, unknown> {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/gone/image.png' } }] } }
}

const PNG = imageBytes('image/png', 900, 1)
const COPY = imageBytes('image/png', 700, 2)
const A = imageBytes('image/png', 400, 3)
const B = imageBytes('image/jpeg', 500, 4)

test("position 0 of a Read result is the result's bytes and media type — not the file (gone) nor the record's copy", async () => {
  const tp = transcript([toolCall('read-1'), readImageRecord('read-1', 'image/png', PNG, COPY)])
  const chunk = await read(new ResultImageIndex(), tp, 'read-1', 0)
  assert.deepEqual(bytesOf(chunk), PNG)
  assert.equal(chunk.mediaType, 'image/png')
  assert.equal(chunk.size, PNG.length)
  assert.equal(chunk.complete, true)
})

test('position 1 of [text, image A, image/bmp, image B] is B, with B’s media type', async () => {
  const tp = transcript([
    resultRecord('mixed', [textBlock('shot'), imageBlock('image/png', A), imageBlock('image/bmp', imageBytes('image/bmp', 90, 5)), imageBlock('image/jpeg', B)]),
  ])
  const chunk = await read(new ResultImageIndex(), tp, 'mixed', 1)
  assert.deepEqual(bytesOf(chunk), B)
  assert.equal(chunk.mediaType, 'image/jpeg')
})

test('a text-only result, another tool’s id, a position past the images and a subagent record are NO_IMAGE', async () => {
  const tp = transcript([
    toolCall('call-only'),
    resultRecord('text-only', [textBlock('"image" is a word here')]),
    resultRecord('one', [imageBlock('image/png', A)]),
    resultRecord('side', [imageBlock('image/png', A)], { isSidechain: true }),
  ])
  const index = new ResultImageIndex()
  for (const [id, i] of [['text-only', 0], ['call-only', 0], ['one', 1], ['side', 0], ['nope', 0]] as const) {
    assert.equal(await code(() => read(index, tp, id, i)), 'NO_IMAGE', `${id}[${i}]`)
  }
  assert.equal(await code(() => read(index, join(root, 'missing.jsonl'), 'one', 0)), 'NO_IMAGE', 'no transcript')
})

test('an api-request-blob record holding the id with another image, after the result and before it, is not read', async () => {
  const tp = transcript([
    requestBlobRecord('real', [imageBlock('image/png', B)]),
    resultRecord('real', [imageBlock('image/png', A)]),
    requestBlobRecord('real', [imageBlock('image/png', COPY)]),
  ])
  assert.deepEqual(bytesOf(await read(new ResultImageIndex(), tp, 'real', 0)), A)
})

test('a half-written result is NO_IMAGE, and found once its line is complete', async () => {
  const tp = transcript([resultRecord('first', [imageBlock('image/png', A)])])
  const index = new ResultImageIndex()
  const line = JSON.stringify(resultRecord('second', [imageBlock('image/png', B)]))
  appendFileSync(tp, line.slice(0, line.length - 30))
  assert.equal(await code(() => read(index, tp, 'second', 0)), 'NO_IMAGE')
  appendFileSync(tp, `${line.slice(line.length - 30)}\n`)
  assert.deepEqual(bytesOf(await read(index, tp, 'second', 0)), B)
})

test('an earlier result is found after a later one was read', async () => {
  const tp = transcript([resultRecord('A', [imageBlock('image/png', A)]), resultRecord('B', [imageBlock('image/jpeg', B)])])
  const index = new ResultImageIndex()
  assert.deepEqual(bytesOf(await read(index, tp, 'B', 0)), B)
  assert.deepEqual(bytesOf(await read(index, tp, 'A', 0)), A)
})

test('a transcript growing between chunks is not scanned again before the found result', async () => {
  const big = imageBytes('image/png', 100_000, 6)
  const tp = transcript([resultRecord('pad', [textBlock('x'.repeat(5000))]), resultRecord('big', [imageBlock('image/png', big)])])
  const index = new ResultImageIndex()
  const first = await read(index, tp, 'big', 0, { offset: 0, length: 60_000 })
  const scanned = index.bytesScanned
  appendFileSync(tp, lines([resultRecord('later', [imageBlock('image/png', A)])]))
  const second = await read(index, tp, 'big', 0, { offset: 60_000, length: 60_000, version: first.version })
  assert.equal(index.bytesScanned, scanned, 'a found result is answered from its location')
  assert.deepEqual(Buffer.concat([bytesOf(first), bytesOf(second)]), big)
})

test('a transcript rewritten in place (same inode, longer) with the result at another offset is still read', async () => {
  const records = [resultRecord('A', [imageBlock('image/png', A)])]
  const tp = transcript(records)
  const index = new ResultImageIndex()
  assert.deepEqual(bytesOf(await read(index, tp, 'A', 0)), A)
  const ino = statSync(tp).ino
  writeFileSync(tp, lines([resultRecord('pad', [textBlock('y'.repeat(3000))]), ...records]))
  assert.equal(statSync(tp).ino, ino, 'rewritten in place')
  assert.deepEqual(bytesOf(await read(index, tp, 'A', 0)), A)
})

test('a transcript replaced by rename: the result at another offset is read, a missing one is NO_IMAGE', async () => {
  const tp = transcript([resultRecord('pad', [textBlock('z'.repeat(3000))]), resultRecord('A', [imageBlock('image/png', A)])])
  const index = new ResultImageIndex()
  assert.deepEqual(bytesOf(await read(index, tp, 'A', 0)), A)
  // Shorter than the old offset would not test the stat: keep it as long, with A earlier.
  writeFileSync(`${tp}.new`, lines([resultRecord('A', [imageBlock('image/png', A)]), resultRecord('pad', [textBlock('z'.repeat(3100))])]))
  renameSync(`${tp}.new`, tp)
  assert.deepEqual(bytesOf(await read(index, tp, 'A', 0)), A)
  writeFileSync(`${tp}.new`, lines([resultRecord('pad', [textBlock('w'.repeat(9000))]), resultRecord('C', [imageBlock('image/png', B)])]))
  renameSync(`${tp}.new`, tp)
  assert.equal(await code(() => read(index, tp, 'A', 0)), 'NO_IMAGE')
})

test('a 1.5 MiB image arrives in 512 KiB chunks; a smaller asked length bounds every chunk', async () => {
  const big = imageBytes('image/png', 1.5 * 1024 * 1024, 7)
  const tp = transcript([resultRecord('big', [imageBlock('image/png', big)])])
  const index = new ResultImageIndex()
  for (const length of [IMAGE_CHUNK_LIMIT, 64 * 1024]) {
    const parts: Buffer[] = []
    let offset = 0
    let version: string | undefined
    for (;;) {
      const chunk = await read(index, tp, 'big', 0, { offset, length, ...(version ? { version } : {}) })
      const part = bytesOf(chunk)
      assert.ok(part.length <= length, `${part.length} <= ${length}`)
      parts.push(part)
      offset += part.length
      version = chunk.version
      if (chunk.complete) break
    }
    assert.deepEqual(Buffer.concat(parts), big)
    assert.equal(parts.length, Math.ceil(big.length / length))
  }
})

test('an offset past the image is BAD_PARAMS', async () => {
  const tp = transcript([resultRecord('A', [imageBlock('image/png', A)])])
  assert.equal(await code(() => read(new ResultImageIndex(), tp, 'A', 0, { offset: A.length + 1, length: 10 })), 'BAD_PARAMS')
})

test('another image under the same id and position, read with the first version, is FILE_CHANGED', async () => {
  const tp = transcript([resultRecord('A', [imageBlock('image/png', A)])])
  const index = new ResultImageIndex()
  const first = await read(index, tp, 'A', 0, { offset: 0, length: 100 })
  writeFileSync(`${tp}.new`, lines([resultRecord('A', [imageBlock('image/png', COPY)])]))
  renameSync(`${tp}.new`, tp)
  assert.equal(await code(() => read(index, tp, 'A', 0, { offset: 100, length: 100, version: first.version })), 'FILE_CHANGED')
})

test('an image over 8 MiB is TOO_LARGE with the limit and no data', async () => {
  const tp = transcript([resultRecord('huge', [imageBlock('image/png', imageBytes('image/png', IMAGE_LIMIT + 1, 8))])])
  const error = await read(new ResultImageIndex(), tp, 'huge', 0).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(error instanceof RemoteError)
  assert.equal(error.code, 'TOO_LARGE')
  assert.deepEqual(error.detail, { limit: IMAGE_LIMIT })
})

test('a result on a line over the guard is TOO_LARGE, and that line is not read', async () => {
  const tp = transcript([resultRecord('pad', [textBlock('p'.repeat(100))]), resultRecord('A', [imageBlock('image/png', A)])])
  const lineOffset = readFileSync(tp).indexOf('\n') + 1
  const reads: number[] = []
  const fs: TranscriptFs = {
    stat: nodeTranscriptFs.stat,
    open: async (file, flags) => {
      const handle = await nodeTranscriptFs.open(file, flags)
      return { ...handle, read: (buffer, offset, length, position) => (reads.push(position), handle.read(buffer, offset, length, position)) }
    },
  }
  const error = await read(new ResultImageIndex(fs, { lineLimit: 200 }), tp, 'A', 0).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(error instanceof RemoteError)
  assert.equal(error.code, 'TOO_LARGE')
  assert.deepEqual(error.detail, { limit: IMAGE_LIMIT })
  assert.equal(reads.includes(lineOffset), false, `reads at ${reads.join(',')}`)
})

test("the entry's size equals the answer's size for the same line", async () => {
  const record = resultRecord('same', [textBlock('t'), imageBlock('image/jpeg', B), imageBlock('image/png', A)])
  const tp = transcript([record])
  const [entry] = project(record) as [Extract<ViewEvent, { kind: 'result' }>]
  const index = new ResultImageIndex()
  for (const [i, listed] of (entry.images ?? []).entries()) {
    const chunk = await read(index, tp, 'same', i)
    assert.equal(chunk.size, listed.size)
    assert.equal(chunk.mediaType, listed.mediaType)
  }
  assert.equal(entry.images?.length, 2)
})
