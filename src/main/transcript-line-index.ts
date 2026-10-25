import { constants } from 'node:fs'
import { open as fsOpen, stat as fsStat } from 'node:fs/promises'

/**
 * An incremental scan of one session's current transcript for lines holding a needle (`remote-result-images` D4).
 *
 * Shared by `files.read` (`SentFileIndex`) and `images.read` (`ResultImageIndex`): each gives a needle and a
 * handler, and keeps what it finds.
 *
 * ## Scanning a transcript that grows
 *
 * Transcripts reach 187 MB and grow while the agent works. They are append-only and a record never changes once
 * written, so a user keeps **every** match it is given and this keeps the byte offset scanned to: a miss scans only
 * what was appended. Recording only the asked id would move the offset past earlier matches never recorded, which
 * could then never be found. An unterminated last line is not handed over and the offset stays before it: the agent
 * may be in the middle of writing it (an `api-request` line reaches 3.3 MB).
 *
 * ## Checking the file on every lookup
 *
 * `check()` `stat`s the transcript before a user answers, **from its cache too**: a new path (after `/clear`), a
 * replaced file (another inode) or a shorter one starts over. Answering a cached hit without looking once returned
 * an id of a transcript that had been replaced. A rewrite in place that is as long or longer is not seen by a `stat`;
 * a user holding byte locations verifies the line and calls `reset()`.
 *
 * ## Byte offsets
 *
 * A line's offset is counted in bytes from the file's start, never from decoded text: a multibyte character before
 * it would shift a character count and a read by position would land inside another line.
 */

const SCAN_BLOCK = 1024 * 1024
const NEWLINE = 0x0a

export interface TranscriptStat {
  ino: bigint
  size: bigint
}

export interface TranscriptHandle {
  stat(): Promise<TranscriptStat>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

/** The file access the scan uses; injected in tests. `remote-sent-files.ts`'s `SentFileFs` is one. */
export interface TranscriptFs {
  stat(file: string): Promise<TranscriptStat>
  open(file: string, flags: number): Promise<TranscriptHandle>
}

export const nodeTranscriptFs: TranscriptFs = {
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

export interface TranscriptLineHandler {
  /** A complete line containing the needle, and its byte offset in the file (the newline excluded). */
  line(line: Buffer, offset: number): void
  /** Everything found so far no longer holds: drop it. */
  reset(): void
}

export class TranscriptLineIndex {
  readonly #fs: TranscriptFs
  readonly #needle: Buffer
  readonly #handler: TranscriptLineHandler
  #path: string | null = null
  #ino: bigint | null = null
  #offset = 0
  /** Bytes read from transcripts, for tests: a scan must not re-read what it already scanned. */
  bytesScanned = 0

  constructor(needle: string, handler: TranscriptLineHandler, fs: TranscriptFs = nodeTranscriptFs) {
    this.#needle = Buffer.from(needle)
    this.#handler = handler
    this.#fs = fs
  }

  /**
   * Looks at the transcript before an answer, hit or miss: another path, another file or a shorter one starts over.
   * `false` when there is no transcript (and nothing found is kept).
   */
  async check(transcriptPath: string): Promise<boolean> {
    let st: TranscriptStat
    try {
      st = await this.#fs.stat(transcriptPath)
    } catch {
      this.#start(transcriptPath, null)
      return false
    }
    if (this.#path !== transcriptPath || this.#ino !== st.ino || Number(st.size) < this.#offset) {
      this.#start(transcriptPath, st.ino)
    }
    return true
  }

  /** Starts the current transcript over from 0: a user found a recorded location no longer holding its match. */
  reset(): void {
    this.#start(this.#path, this.#ino)
  }

  /** Scans what was appended since the last scan (all of it after a start over). */
  async scan(transcriptPath: string): Promise<void> {
    let handle: TranscriptHandle
    try {
      handle = await this.#fs.open(transcriptPath, constants.O_RDONLY)
    } catch {
      // No transcript yet: nothing to find.
      return
    }
    try {
      const st = await handle.stat()
      const size = Number(st.size)
      if (this.#path !== transcriptPath || this.#ino !== st.ino || size < this.#offset) this.#start(transcriptPath, st.ino)
      let position = this.#offset
      let pending = Buffer.alloc(0)
      // The file offset of `pending`'s first byte, which is the next line's start.
      let lineBase = this.#offset
      while (position < size) {
        const block = Buffer.alloc(Math.min(SCAN_BLOCK, size - position))
        const { bytesRead } = await handle.read(block, 0, block.length, position)
        if (bytesRead === 0) break
        position += bytesRead
        this.bytesScanned += bytesRead
        const buf = pending.length ? Buffer.concat([pending, block.subarray(0, bytesRead)]) : block.subarray(0, bytesRead)
        let start = 0
        for (let i = buf.indexOf(NEWLINE); i !== -1; i = buf.indexOf(NEWLINE, start)) {
          const line = buf.subarray(start, i)
          if (line.indexOf(this.#needle) !== -1) this.#handler.line(line, lineBase + start)
          start = i + 1
        }
        pending = buf.subarray(start)
        lineBase += start
        // The offset stays before an unterminated tail: it is handed over once complete.
        this.#offset = lineBase
      }
    } finally {
      await handle.close()
    }
  }

  #start(transcriptPath: string | null, ino: bigint | null): void {
    this.#path = transcriptPath
    this.#ino = ino
    this.#offset = 0
    this.#handler.reset()
  }
}
