import { createHash } from 'node:crypto'
import { constants } from 'node:fs'

import { RemoteError } from './remote-frames'
import { parseLine, resultImagesOf, type ResultImage } from './transcript-follow'
import { nodeTranscriptFs, TranscriptLineIndex, type TranscriptFs } from './transcript-line-index'

/**
 * A paired device reads an image a tool result holds (`remote-result-images`).
 *
 * ## Addressed by the result, read from the transcript
 *
 * The device names a tool result's id and a position among the images its entry lists. The bytes are the result's
 * own base64 in the session's current transcript — what the agent was given — never a file on disk and never the
 * record's `toolUseResult` copy (Read-only, and another shape for MCP tools). Positions are `resultImagesOf()`'s,
 * the same reading the entry's `images` come from, so the image read is the image listed (D1).
 *
 * ## An index of where lines are, not of images
 *
 * Image lines are most of a transcript's bytes (a session holds dozens of screenshots), so the index keeps each
 * result's line location and a read re-reads and re-parses that one line (D4). A location that no longer holds the
 * id — the transcript was rewritten in place — starts the index over once before the answer is `NO_IMAGE`.
 */

/** Decoded image bytes a device can read (D6): measured images reach ≈ 512 KiB. */
export const IMAGE_LIMIT = 8 * 1024 * 1024
/** A guard on the line read to find an image, checked before reading it; not a limit a client plans around. */
export const IMAGE_LINE_LIMIT = 32 * 1024 * 1024
export const IMAGE_CHUNK_LIMIT = 512 * 1024
/** The block `type`'s JSON string token: unescaped, absent from base64, and independent of spacing. */
const NEEDLE = '"image"'

function noImage(): RemoteError {
  return new RemoteError('NO_IMAGE', 'the conversation has no result with that id holding an image at that position')
}

function tooLarge(): RemoteError {
  return new RemoteError('TOO_LARGE', `a result image is read up to ${IMAGE_LIMIT} bytes`, { limit: IMAGE_LIMIT })
}

interface Location {
  offset: number
  length: number
}

/** The images result `toolUseId` holds in a line read by position, or `null` when the line holds none for it. */
function imagesIn(line: Buffer, toolUseId: string): ResultImage[] | null {
  const entry = resultImagesOf(parseLine(line.toString('utf8'))).find((r) => r.toolUseId === toolUseId)
  return entry && entry.images.length > 0 ? entry.images : null
}

/** The results holding images in one session's current transcript: id → where its line is. */
export class ResultImageIndex {
  readonly #fs: TranscriptFs
  readonly #lines: TranscriptLineIndex
  #locations = new Map<string, Location>()
  readonly #lineLimit: number

  constructor(fs: TranscriptFs = nodeTranscriptFs, options: { lineLimit?: number } = {}) {
    this.#fs = fs
    this.#lineLimit = options.lineLimit ?? IMAGE_LINE_LIMIT
    this.#lines = new TranscriptLineIndex(
      NEEDLE,
      {
        line: (line, offset) => {
          // Every result with an image is kept, not only the asked one (`TranscriptLineIndex`).
          for (const r of resultImagesOf(parseLine(line.toString('utf8')))) {
            if (r.images.length > 0) this.#locations.set(r.toolUseId, { offset, length: line.length })
          }
        },
        reset: () => {
          this.#locations = new Map()
        },
      },
      fs,
    )
  }

  /** Bytes read from transcripts by scans, for tests. */
  get bytesScanned(): number {
    return this.#lines.bytesScanned
  }

  /** The images result `toolUseId` holds; throws `NO_IMAGE`, or `TOO_LARGE` for a line over the guard. */
  async images(transcriptPath: string, toolUseId: string): Promise<ResultImage[]> {
    const first = await this.#find(transcriptPath, toolUseId)
    if (first) return first
    // A recorded location that no longer holds the id: the transcript was rewritten in place. Start over once.
    this.#lines.reset()
    const again = await this.#find(transcriptPath, toolUseId)
    if (!again) throw noImage()
    return again
  }

  async #find(transcriptPath: string, toolUseId: string): Promise<ResultImage[] | null> {
    if (!(await this.#lines.check(transcriptPath))) throw noImage()
    let location = this.#locations.get(toolUseId)
    if (!location) {
      await this.#lines.scan(transcriptPath)
      location = this.#locations.get(toolUseId)
      if (!location) throw noImage()
    }
    if (location.length > this.#lineLimit) throw tooLarge()
    const line = await this.#read(transcriptPath, location)
    return line ? imagesIn(line, toolUseId) : null
  }

  async #read(transcriptPath: string, location: Location): Promise<Buffer | null> {
    let handle
    try {
      handle = await this.#fs.open(transcriptPath, constants.O_RDONLY)
    } catch {
      return null
    }
    try {
      const buffer = Buffer.alloc(location.length)
      let got = 0
      while (got < location.length) {
        const { bytesRead } = await handle.read(buffer, got, location.length - got, location.offset + got)
        if (bytesRead === 0) break
        got += bytesRead
      }
      return got === location.length ? buffer : null
    } finally {
      await handle.close()
    }
  }
}

export interface ImageChunk {
  size: number
  mediaType: string
  version: string
  offset: number
  data: string
  complete: boolean
}

/**
 * One chunk of image `index` of result `toolUseId` (D5). `version` from an earlier chunk must still be the image's
 * (`FILE_CHANGED`: the transcript was replaced by one holding another image there).
 */
export async function readResultImage(
  images: ResultImageIndex,
  transcriptPath: string,
  toolUseId: string,
  index: number,
  request: { offset: number; length: number; version?: string },
): Promise<ImageChunk> {
  const image = (await images.images(transcriptPath, toolUseId))[index]
  if (!image) throw noImage()
  // On the length, before decoding: a malformed or future record must not make the desktop decode and hold it.
  if (Buffer.byteLength(image.data, 'base64') > IMAGE_LIMIT) throw tooLarge()
  const bytes = Buffer.from(image.data, 'base64')
  const version = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  if (request.version !== undefined && request.version !== version) {
    throw new RemoteError('FILE_CHANGED', 'the image changed since the first chunk; start again from 0')
  }
  if (request.offset > bytes.length) {
    throw new RemoteError('BAD_PARAMS', '`offset` is past the end of the image', { size: bytes.length })
  }
  const chunk = bytes.subarray(request.offset, request.offset + request.length)
  return {
    size: bytes.length,
    mediaType: image.mediaType,
    version,
    offset: request.offset,
    data: chunk.toString('base64'),
    complete: request.offset + chunk.length === bytes.length,
  }
}
