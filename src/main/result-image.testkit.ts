/**
 * Test helpers for tool results holding images (`remote-result-images`), shaped as the agent records them
 * (measured, CLI 2.1.258–2.1.310): the image's bytes are replaced by small generated ones.
 *
 * The desktop never decodes an image, so the bytes only need a recognizable header and content that differs per
 * `seed` — a test then tells two images apart by their bytes.
 */

const HEADERS: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/gif': [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
  'image/bmp': [0x42, 0x4d],
}

/** Image bytes of `length` (at least the header), different for each `seed`. */
export function imageBytes(mediaType: string, length: number, seed = 1): Buffer {
  const header = HEADERS[mediaType] ?? []
  const out = Buffer.alloc(Math.max(length, header.length))
  Buffer.from(header).copy(out)
  let x = (seed * 2654435761) >>> 0
  for (let i = header.length; i < out.length; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

export function imageBlock(mediaType: string, bytes: Buffer): Record<string, unknown> {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } }
}

export function textBlock(text: string): Record<string, unknown> {
  return { type: 'text', text }
}

/** A `user` record holding one tool result, as the agent writes it. `extra` adds top-level fields. */
export function resultRecord(
  toolUseId: string,
  content: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'user',
    uuid: `u-${toolUseId}`,
    timestamp: '2026-10-25T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    ...extra,
  }
}

/** The agent's `api-request-blob` record: the same id and blocks, in the same `message.content` shape (measured). */
export function requestBlobRecord(toolUseId: string, content: unknown): Record<string, unknown> {
  return {
    type: 'api-request-blob',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  }
}

/** A `Read` of an image: the result's image, plus the record's own copy in `toolUseResult` (measured). */
export function readImageRecord(toolUseId: string, mediaType: string, bytes: Buffer, copy: Buffer): Record<string, unknown> {
  return resultRecord(toolUseId, [imageBlock(mediaType, bytes)], {
    toolUseResult: {
      type: 'image',
      file: { base64: copy.toString('base64'), type: mediaType, originalSize: copy.length, dimensions: { originalWidth: 1, originalHeight: 1 } },
    },
  })
}
