import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, constants, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { RemoteError } from './remote-frames'
import {
  CHUNK_LIMIT,
  READ_FLAGS,
  SENT_FILE_LIMIT,
  SentFileIndex,
  mediaTypeOf,
  nodeSentFileFs,
  readChunk,
  type SentFileFs,
  type StatLike,
} from './remote-sent-files'

const root = mkdtempSync(join(tmpdir(), 'spekterm-sent-files-'))
after(() => rmSync(root, { recursive: true, force: true }))
let seq = 0
function dir(): string {
  const d = join(root, `d${++seq}`)
  mkdirSync(d)
  return d
}

// Shapes as the CLI records them (CLI 2.1.30x); bodies generic.
function sendCall(id: string, files: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${id}`,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'SendUserFile', input: { files, caption: 'c', status: 'normal' } }] },
    ...extra,
  })
}
/** Another tool's call, in the same record as a `SendUserFile` call so the line passes the scan's byte filter. */
function otherCall(id: string, name: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id, name, input: { files: ['/etc/hostname'] } },
        { type: 'tool_use', id: `${id}-send`, name: 'SendUserFile', input: { files: ['/etc/hostname'] } },
      ],
    },
  })
}
function transcript(lines: string[]): string {
  const file = join(dir(), 't.jsonl')
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
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

test('a listed file is found and read whole, with its name and media type', async () => {
  const d = dir()
  const file = join(d, 'Report.MD')
  writeFileSync(file, '# hello')
  const tp = transcript([sendCall('t1', [file])])
  const index = new SentFileIndex()
  assert.equal(await index.find(tp, 't1', 0), file)
  const chunk = await readChunk(file, { offset: 0, length: CHUNK_LIMIT })
  assert.equal(chunk.name, 'Report.MD')
  assert.equal(chunk.mediaType, 'text/markdown')
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), '# hello')
  assert.equal(chunk.size, 7)
  assert.equal(chunk.complete, true)
})

test('anything the transcript does not list as sent is FILE_NOT_SENT', async () => {
  const tp = transcript([
    otherCall('edit-1', 'Edit'),
    // The decoy: an api-request record holding the asked id with other files.
    JSON.stringify({ type: 'api-request', message: { content: [{ type: 'tool_use', id: 'decoy', name: 'SendUserFile', input: { files: ['/etc/hostname'] } }] } }),
    sendCall('rel', ['relative/path.md']),
    sendCall('side', ['/etc/hostname'], { isSidechain: true }),
    sendCall('mixed', ['/etc/hostname', 3]),
  ])
  const index = new SentFileIndex()
  for (const [id, i] of [['nope', 0], ['edit-1', 0], ['decoy', 0], ['rel', 0], ['side', 0], ['mixed', 1], ['mixed', 2]] as const) {
    assert.equal(await code(() => index.find(tp, id, i)), 'FILE_NOT_SENT', `${id}[${i}]`)
  }
  assert.equal(await index.find(tp, 'mixed', 0), '/etc/hostname', 'positions are the record positions')
  assert.equal(await code(() => index.find(join(root, 'missing.jsonl'), 'x', 0)), 'FILE_NOT_SENT', 'no transcript')
})

test('an earlier call is found after a later one, and after a miss', async () => {
  const tp = transcript([sendCall('A', ['/a.md']), otherCall('e', 'Edit'), sendCall('B', ['/b.md'])])
  const index = new SentFileIndex()
  assert.equal(await code(() => index.find(tp, 'unknown', 0)), 'FILE_NOT_SENT')
  assert.equal(await index.find(tp, 'B', 0), '/b.md')
  assert.equal(await index.find(tp, 'A', 0), '/a.md')
})

test('a growing transcript is scanned only where it grew; a half-written line is found once complete', async () => {
  const tp = transcript([sendCall('A', ['/a.md']), 'x'.repeat(5000)])
  const index = new SentFileIndex()
  assert.equal(await index.find(tp, 'A', 0), '/a.md')
  const first = index.bytesScanned
  const line = sendCall('B', ['/b.md'])
  appendFileSync(tp, line.slice(0, 40))
  assert.equal(await code(() => index.find(tp, 'B', 0)), 'FILE_NOT_SENT', 'half a line')
  appendFileSync(tp, `${line.slice(40)}\n`)
  assert.equal(await index.find(tp, 'B', 0), '/b.md')
  // The half line is read twice; nothing before it is read again.
  assert.equal(index.bytesScanned - first, 40 + line.length + 1)
  assert.equal(await index.find(tp, 'A', 0), '/a.md')
  assert.equal(index.bytesScanned - first, 40 + line.length + 1, 'a found call is answered from the index')
})

test('a replaced or shorter transcript, or another path, starts over', async () => {
  const tp = transcript([sendCall('A', ['/a.md'])])
  const index = new SentFileIndex()
  assert.equal(await index.find(tp, 'A', 0), '/a.md')
  const next = `${tp}.new`
  writeFileSync(next, `${sendCall('C', ['/c.md'])}\n`)
  renameSync(next, tp)
  assert.equal(await index.find(tp, 'C', 0), '/c.md')
  // Rewritten in place, shorter (append-only otherwise; an in-place rewrite as long or longer is not detected).
  writeFileSync(tp, `${sendCall('D', ['/d'])}\n`)
  assert.equal(await index.find(tp, 'D', 0), '/d')
  const other = transcript([sendCall('E', ['/e.md'])])
  assert.equal(await index.find(other, 'E', 0), '/e.md')
  assert.equal(await code(() => index.find(other, 'D', 0)), 'FILE_NOT_SENT', 'calls of the previous transcript are dropped')
})

test("a call of a replaced transcript is no longer found, though it was found before", async () => {
  const tp = transcript([sendCall('A', ['/a.md'])])
  const index = new SentFileIndex()
  assert.equal(await index.find(tp, 'A', 0), '/a.md')
  const next = `${tp}.new`
  writeFileSync(next, `${sendCall('B', ['/b.md'])}\n${'x'.repeat(200)}\n`)
  renameSync(next, tp)
  assert.equal(await code(() => index.find(tp, 'A', 0)), 'FILE_NOT_SENT', 'a cached hit is checked against the file')
  assert.equal(await index.find(tp, 'B', 0), '/b.md')
})

test('a large file arrives in chunks, of at most the asked length', async () => {
  const file = join(dir(), 'big.bin')
  const content = Buffer.alloc(2 * 1024 * 1024, 7)
  content[content.length - 1] = 9
  writeFileSync(file, content)
  const parts: Buffer[] = []
  let offset = 0
  let version: string | undefined
  let complete = false
  let chunks = 0
  while (!complete) {
    const chunk = await readChunk(file, { offset, length: CHUNK_LIMIT, version })
    version = chunk.version
    const data = Buffer.from(chunk.data, 'base64')
    assert.ok(data.length <= CHUNK_LIMIT)
    parts.push(data)
    offset += data.length
    complete = chunk.complete
    chunks += 1
  }
  assert.equal(chunks, 4)
  assert.ok(Buffer.concat(parts).equals(content))
  const small = await readChunk(file, { offset: 0, length: 64 * 1024 })
  assert.equal(Buffer.from(small.data, 'base64').length, 64 * 1024)
  assert.equal(small.complete, false)
  assert.equal(await code(() => readChunk(file, { offset: content.length + 1, length: 1 })), 'BAD_PARAMS')
  const end = await readChunk(file, { offset: content.length, length: 1 })
  assert.equal(end.data, '')
  assert.equal(end.complete, true)
})

test('a change between chunks is FILE_CHANGED: an equal-size rewrite, and a rename-replace', async () => {
  const d = dir()
  const file = join(d, 'a.txt')
  writeFileSync(file, 'aaaa')
  const first = await readChunk(file, { offset: 0, length: 2 })
  writeFileSync(file, 'bbbb')
  // The kernel's coarse clock may keep the mtime (measured); move it, as a later write would.
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)
  assert.equal(await code(() => readChunk(file, { offset: 2, length: 2, version: first.version })), 'FILE_CHANGED')
  const now = await readChunk(file, { offset: 0, length: 2 })
  const st = statSync(file)
  const next = join(d, 'next.txt')
  writeFileSync(next, 'cccc')
  utimesSync(next, st.atime, st.mtime)
  renameSync(next, file)
  assert.equal(await code(() => readChunk(file, { offset: 2, length: 2, version: now.version })), 'FILE_CHANGED', 'same size and mtime, new inode')
})

test('missing, a directory, a dangling or looping link are FILE_GONE; a link to a file is followed', async () => {
  const d = dir()
  assert.equal(await code(() => readChunk(join(d, 'none'), { offset: 0, length: 1 })), 'FILE_GONE')
  assert.equal(await code(() => readChunk(d, { offset: 0, length: 1 })), 'FILE_GONE')
  symlinkSync(join(d, 'none'), join(d, 'dangling'))
  assert.equal(await code(() => readChunk(join(d, 'dangling'), { offset: 0, length: 1 })), 'FILE_GONE')
  symlinkSync(join(d, 'loop'), join(d, 'loop'))
  assert.equal(await code(() => readChunk(join(d, 'loop'), { offset: 0, length: 1 })), 'FILE_GONE')
  writeFileSync(join(d, 'target.png'), 'png')
  symlinkSync(join(d, 'target.png'), join(d, 'link.md'))
  const chunk = await readChunk(join(d, 'link.md'), { offset: 0, length: 10 })
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'png')
  assert.equal(chunk.name, 'link.md')
})

test('whatever the agent listed is read: a file named like a secret, a hard link', async () => {
  const d = join(dir(), 'Spekterm')
  mkdirSync(d)
  writeFileSync(join(d, 'secrets.json'), '{"k":1}')
  linkSync(join(d, 'secrets.json'), join(root, `hard-${seq}.json`))
  for (const file of [join(d, 'secrets.json'), join(root, `hard-${seq}.json`)]) {
    const chunk = await readChunk(file, { offset: 0, length: 100 })
    assert.equal(Buffer.from(chunk.data, 'base64').toString(), '{"k":1}', file)
  }
})

test('an oversized file is TOO_LARGE with the limit, and no content', async () => {
  const file = join(dir(), 'huge.bin')
  writeFileSync(file, '')
  truncateSync(file, SENT_FILE_LIMIT + 1)
  try {
    await readChunk(file, { offset: 0, length: 1 })
    assert.fail('read')
  } catch (error) {
    assert.ok(error instanceof RemoteError)
    assert.equal(error.code, 'TOO_LARGE')
    assert.deepEqual(error.detail, { limit: SENT_FILE_LIMIT })
  }
})

/** File access that records `open` calls and can present a FIFO, without ever blocking. */
function fakeFs(statAs: 'file' | 'fifo', openAs: 'file' | 'fifo' | 'other-inode'): { fs: SentFileFs; opens: number[] } {
  const opens: number[] = []
  const st = (kind: 'file' | 'fifo', ino = 1n): StatLike => ({ dev: 1n, ino, size: 3n, mtimeNs: 1n, isFile: () => kind === 'file' })
  return {
    opens,
    fs: {
      realpath: async (file) => file,
      stat: async () => st(statAs),
      open: async (_file, flags) => {
        opens.push(flags)
        return {
          stat: async () => (openAs === 'other-inode' ? st('file', 2n) : st(openAs)),
          read: async () => ({ bytesRead: 0 }),
          close: async () => undefined,
        }
      },
    },
  }
}

test('a FIFO never reaches open; a swap to a FIFO or another file after stat is FILE_GONE', async () => {
  const fifo = fakeFs('fifo', 'fifo')
  assert.equal(await code(() => readChunk('/x', { offset: 0, length: 1 }, fifo.fs)), 'FILE_GONE')
  assert.equal(fifo.opens.length, 0, 'open was called on a FIFO')
  const swapped = fakeFs('file', 'fifo')
  assert.equal(await code(() => readChunk('/x', { offset: 0, length: 1 }, swapped.fs)), 'FILE_GONE')
  assert.equal(swapped.opens.length, 1)
  const required = constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0) | (constants.O_NOCTTY ?? 0)
  assert.equal(swapped.opens[0] & required, required, 'opened without O_NONBLOCK / O_NOFOLLOW / O_NOCTTY')
  assert.equal(swapped.opens[0], READ_FLAGS)
  const other = fakeFs('file', 'other-inode')
  assert.equal(await code(() => readChunk('/x', { offset: 0, length: 1 }, other.fs)), 'FILE_GONE')
})

test('a real FIFO with no writer is FILE_GONE at once', { skip: process.platform === 'win32' }, async () => {
  const fifo = join(dir(), 'pipe')
  execFileSync('mkfifo', [fifo])
  const started = Date.now()
  assert.equal(await code(() => readChunk(fifo, { offset: 0, length: 1 }, nodeSentFileFs)), 'FILE_GONE')
  assert.ok(Date.now() - started < 1000)
})

test('media types by extension, case-insensitive', () => {
  assert.equal(mediaTypeOf('/a/B.JPG'), 'image/jpeg')
  assert.equal(mediaTypeOf('/a/b.markdown'), 'text/markdown')
  assert.equal(mediaTypeOf('/a/b.yml'), 'text/plain')
  assert.equal(mediaTypeOf('/a/b.mp4'), 'video/mp4')
  assert.equal(mediaTypeOf('/a/b.unknown'), 'application/octet-stream')
  assert.equal(mediaTypeOf('/a/noext'), 'application/octet-stream')
})
