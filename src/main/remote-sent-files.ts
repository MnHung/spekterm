import { constants } from 'node:fs'
import { open as fsOpen, realpath as fsRealpath, stat as fsStat } from 'node:fs/promises'
import path from 'node:path'

import { RemoteError } from './remote-frames'

/**
 * A paired device reads a file the agent sent to the user (`remote-sent-files`, `remote-tool-detail` D6).
 *
 * ## Addressed by the tool call, never by a path
 *
 * The device names a `SendUserFile` call's id and a position in its `files`. The path comes from the session's
 * **current** transcript, as recorded and untruncated. Whatever the agent listed is read, credentials included
 * (the user's decision): a device can already read any file through the terminal, so a refusal list would add no
 * protection and could never be complete.
 *
 * ## Scanning a transcript that grows
 *
 * Transcripts reach 112 MB and grow while the agent works. They are append-only and an `assistant` record never
 * changes once written, so an index keeps **every** call it has found and the byte offset scanned to, and a miss
 * scans only what was appended. Recording only the asked id would move the offset past earlier calls it never
 * recorded, which could then never be found. An unterminated last line is not parsed and the offset stays before
 * it: the agent may be in the middle of writing it (an `api-request` line reaches 3.3 MB). The id also appears in
 * result and `api-request` records (measured), hence `type === "assistant"`.
 *
 * ## Reading without waiting on the file
 *
 * `stat` before opening, and open with `O_NONBLOCK`: opening a FIFO without it blocks forever, holding one of
 * libuv's four pool threads, and a process with one stuck does not exit (measured). The real path is opened with
 * `O_NOFOLLOW` and the descriptor must be the file that was `stat`ed, so a swap in between is `FILE_GONE`.
 */

export const SENT_FILE_LIMIT = 32 * 1024 * 1024
export const CHUNK_LIMIT = 512 * 1024
const SCAN_BLOCK = 1024 * 1024
const NEEDLE = Buffer.from('"SendUserFile"')
const NEWLINE = 0x0a

export interface StatLike {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  isFile(): boolean
}

export interface HandleLike {
  stat(): Promise<StatLike>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

/** The file access this module uses; injected in tests. */
export interface SentFileFs {
  realpath(file: string): Promise<string>
  stat(file: string): Promise<StatLike>
  open(file: string, flags: number): Promise<HandleLike>
}

export const nodeSentFileFs: SentFileFs = {
  realpath: (file) => fsRealpath(file),
  stat: (file) => fsStat(file, { bigint: true }),
  open: async (file, flags) => {
    const handle = await fsOpen(file, flags)
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    }
  },
}

/** `O_NOCTTY` and `O_NOFOLLOW` are POSIX; absent on Windows. */
export const READ_FLAGS =
  constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0) | (constants.O_NOCTTY ?? 0)

const GONE_CODES = new Set(['ENOENT', 'ELOOP', 'ENOTDIR', 'EACCES'])

function gone(): RemoteError {
  return new RemoteError('FILE_GONE', 'the file is no longer there, or is not a regular file')
}

function notSent(): RemoteError {
  return new RemoteError('FILE_NOT_SENT', 'the conversation has no file sent by that call at that position')
}

/** Maps a missing or unreadable file to `FILE_GONE`; anything else is rethrown. */
async function orGone<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (GONE_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw gone()
    throw error
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The `SendUserFile` calls of one parsed transcript line: id → files (a non-string item kept as `null`). */
export function sentFileCalls(line: unknown): [string, (string | null)[]][] {
  const r = record(line)
  if (!r || r.type !== 'assistant' || r.isSidechain === true) return []
  const content = record(r.message)?.content
  if (!Array.isArray(content)) return []
  const out: [string, (string | null)[]][] = []
  for (const block of content) {
    const b = record(block)
    if (!b || b.type !== 'tool_use' || b.name !== 'SendUserFile' || typeof b.id !== 'string') continue
    const files = record(b.input)?.files
    if (!Array.isArray(files)) continue
    out.push([b.id, files.map((file) => (typeof file === 'string' ? file : null))])
  }
  return out
}

/**
 * The `SendUserFile` calls of one session's current transcript, scanned incrementally. A new transcript (after
 * `/clear`), a replaced file (another inode) or a shorter one starts over.
 */
export class SentFileIndex {
  readonly #fs: SentFileFs
  #path: string | null = null
  #ino: bigint | null = null
  #offset = 0
  #calls = new Map<string, (string | null)[]>()
  /** Bytes read from transcripts, for tests: a scan must not re-read what it already scanned. */
  bytesScanned = 0

  constructor(fs: SentFileFs = nodeSentFileFs) {
    this.#fs = fs
  }

  /** The recorded path of file `index` of call `toolUseId`; throws `FILE_NOT_SENT`. */
  async find(transcriptPath: string, toolUseId: string, index: number): Promise<string> {
    let files = this.#path === transcriptPath ? this.#calls.get(toolUseId) : undefined
    if (!files) {
      await this.#scan(transcriptPath)
      files = this.#calls.get(toolUseId)
    }
    const file = files?.[index]
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw notSent()
    return file
  }

  #reset(transcriptPath: string, ino: bigint | null): void {
    this.#path = transcriptPath
    this.#ino = ino
    this.#offset = 0
    this.#calls = new Map()
  }

  async #scan(transcriptPath: string): Promise<void> {
    let handle: HandleLike
    try {
      handle = await this.#fs.open(transcriptPath, constants.O_RDONLY)
    } catch {
      // No transcript yet: nothing was sent.
      return
    }
    try {
      const st = await handle.stat()
      const size = Number(st.size)
      if (this.#path !== transcriptPath || this.#ino !== st.ino || size < this.#offset) this.#reset(transcriptPath, st.ino)
      let position = this.#offset
      let pending = Buffer.alloc(0)
      while (position < size) {
        const block = Buffer.alloc(Math.min(SCAN_BLOCK, size - position))
        const { bytesRead } = await handle.read(block, 0, block.length, position)
        if (bytesRead === 0) break
        position += bytesRead
        this.bytesScanned += bytesRead
        const buf = pending.length ? Buffer.concat([pending, block.subarray(0, bytesRead)]) : block.subarray(0, bytesRead)
        let start = 0
        for (let i = buf.indexOf(NEWLINE); i !== -1; i = buf.indexOf(NEWLINE, start)) {
          this.#line(buf.subarray(start, i))
          start = i + 1
        }
        pending = buf.subarray(start)
        // The offset stays before an unterminated tail: it is parsed once complete.
        this.#offset = position - pending.length
      }
    } finally {
      await handle.close()
    }
  }

  #line(line: Buffer): void {
    if (line.indexOf(NEEDLE) === -1) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line.toString('utf8'))
    } catch {
      return
    }
    for (const [id, files] of sentFileCalls(parsed)) this.#calls.set(id, files)
  }
}

const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  // As text, so a client shows it without knowing a YAML type.
  yaml: 'text/plain',
  yml: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  zip: 'application/zip',
}

export function mediaTypeOf(file: string): string {
  return MEDIA_TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

export interface SentChunk {
  name: string
  size: number
  mediaType: string
  version: string
  offset: number
  data: string
  complete: boolean
}

/** One chunk of a sent file. `version` from an earlier chunk must still be the file's (`FILE_CHANGED`). */
export async function readChunk(
  file: string,
  request: { offset: number; length: number; version?: string },
  fs: SentFileFs = nodeSentFileFs,
): Promise<SentChunk> {
  const real = await orGone(() => fs.realpath(file))
  const checked = await orGone(() => fs.stat(real))
  if (!checked.isFile()) throw gone()
  const handle = await orGone(() => fs.open(real, READ_FLAGS))
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.dev !== checked.dev || st.ino !== checked.ino) throw gone()
    const size = Number(st.size)
    if (size > SENT_FILE_LIMIT) {
      throw new RemoteError('TOO_LARGE', `a sent file is read up to ${SENT_FILE_LIMIT} bytes`, { limit: SENT_FILE_LIMIT })
    }
    const version = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`
    if (request.version !== undefined && request.version !== version) {
      throw new RemoteError('FILE_CHANGED', 'the file changed since the first chunk; start again from 0')
    }
    if (request.offset > size) throw new RemoteError('BAD_PARAMS', '`offset` is past the end of the file', { size })
    // Never more than the size says (some files report 0 and still yield bytes).
    const want = Math.min(request.length, size - request.offset)
    const buffer = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const { bytesRead } = await handle.read(buffer, got, want - got, request.offset + got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return {
      name: path.basename(file),
      size,
      mediaType: mediaTypeOf(file),
      version,
      offset: request.offset,
      data: buffer.subarray(0, got).toString('base64'),
      complete: request.offset + got === size,
    }
  } finally {
    await handle.close()
  }
}
