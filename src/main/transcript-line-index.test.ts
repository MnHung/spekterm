import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { TranscriptLineIndex } from './transcript-line-index'

const root = mkdtempSync(join(tmpdir(), 'spekterm-line-index-'))
after(() => rmSync(root, { recursive: true, force: true }))
let seq = 0
function transcript(lines: string[]): string {
  const d = join(root, `d${++seq}`)
  mkdirSync(d)
  const file = join(d, 't.jsonl')
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
  return file
}

function collect(needle: string): { index: TranscriptLineIndex; found: { line: string; offset: number; length: number }[] } {
  const found: { line: string; offset: number; length: number }[] = []
  const index = new TranscriptLineIndex(needle, {
    line: (line, offset) => found.push({ line: line.toString('utf8'), offset, length: line.length }),
    reset: () => {
      found.length = 0
    },
  })
  return { index, found }
}

test("a matched line's offset and length read back exactly that line, past multibyte text and a scan block boundary", async () => {
  const cjk = JSON.stringify({ type: 'user', message: { content: '中文的訊息'.repeat(40) } })
  const first = JSON.stringify({ type: 'user', marker: 'image', n: 1 })
  // Crosses the 1 MiB scan block: it starts before the boundary and ends after it.
  const filler = JSON.stringify({ pad: 'x'.repeat(1024 * 1024 - 2000) })
  const crossing = JSON.stringify({ type: 'user', marker: 'image', body: '測'.repeat(3000) })
  const tp = transcript([cjk, first, cjk, filler, crossing])
  const { index, found } = collect('"image"')
  await index.scan(tp)
  assert.equal(found.length, 2)
  const bytes = readFileSync(tp)
  assert.ok(found[1].offset < 1024 * 1024 && found[1].offset + found[1].length > 1024 * 1024, 'the line crosses the block')
  for (const f of found) {
    assert.equal(bytes.subarray(f.offset, f.offset + f.length).toString('utf8'), f.line)
  }
  assert.deepEqual(
    found.map((f) => JSON.parse(f.line).n ?? 'crossing'),
    [1, 'crossing'],
  )
})

test('a needle is found however the record is spaced', async () => {
  const tp = transcript(['{"type": "image", "a": 1}', '{"type":"text"}'])
  const { index, found } = collect('"image"')
  await index.scan(tp)
  assert.deepEqual(
    found.map((f) => f.line),
    ['{"type": "image", "a": 1}'],
  )
})
