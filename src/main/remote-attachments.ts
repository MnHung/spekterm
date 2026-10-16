import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { InjectionContribution } from './agent-injection'
import { RemoteError } from './remote-frames'

/**
 * Files a paired device attaches to a reply (`remote-attachments`, D6 of `remote-prompts-attachments-rename`).
 *
 * ## The desktop owns where they go
 *
 * `<userData>/remote-attachments/<sessionId>/`, with `pending/` (uploaded, not sent yet; `.partial` while
 * arriving) and `sent/`. **No parameter can carry a path**: the device sends a file name, which is reduced to
 * `[A-Za-z0-9._-]` and prefixed with a new id, and the joined path is checked with `path.relative` — the
 * repository's boundary idiom, although the cleaned name cannot leave the directory. Whether an attachment
 * was sent is where it lies on disk, so it survives a restart. Files are written 0600.
 *
 * ## What is accepted is decided by the bytes
 *
 * PNG, JPEG, GIF, WebP and PDF by their signature; otherwise UTF-8 text with no NUL. Text named like an image or
 * with no extension gets `.txt`, so the agent's Read tool does not decode it as an image.
 *
 * ## How the agent reads them
 *
 * A read rule for the whole store in the injected settings (`prepareAttachmentAccess`): measured (CLI 2.1.300),
 * reading outside the working directories otherwise raises a permission prompt, and the rule merges with the
 * user's own permissions. A rule and not `additionalDirectories`, which would also let accept-edits mode write
 * there.
 */

export const LIMITS = {
  /** Decoded bytes per chunk: base64 makes 699,052 characters, under the 1 MiB frame cap. */
  chunk: 512 * 1024,
  file: 10 * 1024 * 1024,
  perReply: 10,
  perSession: 200 * 1024 * 1024,
  /** Attachments not sent yet per session, uploads in progress included. */
  unsent: 10,
} as const

export const UNSENT_MS = 24 * 60 * 60 * 1000
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000

const SIGNATURES: { ext: string; test: (head: Buffer) => boolean }[] = [
  { ext: 'png', test: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', test: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  { ext: 'gif', test: (h) => ['GIF87a', 'GIF89a'].includes(h.subarray(0, 6).toString('latin1')) },
  { ext: 'webp', test: (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP' },
  { ext: 'pdf', test: (h) => h.subarray(0, 5).toString('latin1') === '%PDF-' },
]
const BINARY_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'])

/** The kind of a complete file: a signature's extension, `'txt'`, or `null` (not accepted). */
export function kindOf(content: Buffer): string | null {
  for (const signature of SIGNATURES) if (signature.test(content)) return signature.ext
  if (content.includes(0)) return null
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content)
    return 'txt'
  } catch {
    return null
  }
}

/** The device's name reduced to a safe basename, with the extension its content implies. */
export function storedName(raw: string, kind: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  let name = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80)
  if (name === '') name = 'attachment'
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1].toLowerCase() ?? null
  if (kind === 'txt') {
    if (ext === null || BINARY_EXTENSIONS.has(ext)) name = `${name}.txt`
  } else if (!(ext === kind || (kind === 'jpg' && ext === 'jpeg'))) {
    name = `${name}.${kind}`
  }
  return name
}

export interface PutParams {
  name: unknown
  size: unknown
  offset: unknown
  data: unknown
  attachmentId?: unknown
}

export interface PutResult {
  attachmentId: string
  received: number
  complete: boolean
}

interface Upload {
  sessionId: string
  name: string
  size: number
  received: number
}

export interface Reservation {
  /** Where the attachments will be once sent: the paths the reply names. */
  readonly paths: readonly string[]
  /** Moves the attachments to `sent/`. Call right after the reply's text is written. */
  commit(): void
  /** The reply failed before its text: the attachments stay unsent. */
  release(): void
}

export interface AttachmentStoreDeps {
  now?: () => number
  newId?: () => string
}

export class AttachmentStore {
  readonly #uploads = new Map<string, Upload>()
  readonly #reserved = new Set<string>()
  readonly #now: () => number
  readonly #newId: () => string

  constructor(
    readonly root: string,
    deps: AttachmentStoreDeps = {},
  ) {
    this.#now = deps.now ?? Date.now
    this.#newId = deps.newId ?? (() => randomUUID().replaceAll('-', ''))
  }

  #dir(sessionId: string, part: 'pending' | 'sent'): string {
    const dir = path.join(this.root, sessionId, part)
    const relative = path.relative(this.root, dir)
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep)[0] !== sessionId) {
      throw new RemoteError('NOT_FOUND', 'no such session')
    }
    return dir
  }

  /** The joined path, checked to lie in `dir`. */
  #inside(dir: string, name: string): string {
    const target = path.join(dir, name)
    const relative = path.relative(dir, target)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
      throw new RemoteError('BAD_PARAMS', 'the file name is not usable')
    }
    return target
  }

  #files(dir: string): string[] {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  }

  #storedBytes(sessionId: string): number {
    let total = 0
    for (const part of ['pending', 'sent'] as const) {
      const dir = this.#dir(sessionId, part)
      for (const name of this.#files(dir)) {
        try {
          total += fs.statSync(path.join(dir, name)).size
        } catch {
          // gone meanwhile
        }
      }
    }
    for (const upload of this.#uploads.values()) if (upload.sessionId === sessionId) total += upload.size - upload.received
    return total
  }

  #unsentCount(sessionId: string): number {
    const pending = this.#files(this.#dir(sessionId, 'pending')).filter((name) => !name.endsWith('.partial')).length
    let uploading = 0
    for (const upload of this.#uploads.values()) if (upload.sessionId === sessionId) uploading += 1
    return pending + uploading
  }

  /** Removes this session's unsent attachments older than `UNSENT_MS`. */
  #sweepUnsent(sessionId: string): void {
    const dir = this.#dir(sessionId, 'pending')
    for (const name of this.#files(dir)) {
      const file = path.join(dir, name)
      try {
        if (this.#now() - fs.statSync(file).mtimeMs > UNSENT_MS) {
          fs.rmSync(file, { force: true })
          const id = name.split(/[-.]/)[0]
          this.#uploads.delete(id)
        }
      } catch {
        // gone meanwhile
      }
    }
  }

  /** One chunk of an upload (`attachments.put`). */
  put(sessionId: string, p: PutParams): PutResult {
    if (typeof p.data !== 'string') throw new RemoteError('BAD_PARAMS', '`data` must be base64')
    const bytes = Buffer.from(p.data, 'base64')
    if (bytes.length > LIMITS.chunk) throw new RemoteError('TOO_LARGE', 'a chunk is too large', { limit: LIMITS.chunk })
    const offset = p.offset
    if (!Number.isInteger(offset) || (offset as number) < 0) throw new RemoteError('BAD_PARAMS', '`offset` must be a whole number')
    const pendingDir = this.#dir(sessionId, 'pending')

    let id: string
    let upload: Upload
    if (p.attachmentId === undefined || p.attachmentId === null) {
      if (offset !== 0) throw new RemoteError('BAD_PARAMS', 'a new upload starts at offset 0', { received: 0 })
      const size = p.size
      if (!Number.isInteger(size) || (size as number) < 1) throw new RemoteError('BAD_PARAMS', '`size` must be a positive whole number')
      if ((size as number) > LIMITS.file) throw new RemoteError('TOO_LARGE', 'the file is too large', { limit: LIMITS.file })
      if (typeof p.name !== 'string') throw new RemoteError('BAD_PARAMS', '`name` must be a string')
      this.#sweepUnsent(sessionId)
      if (this.#unsentCount(sessionId) >= LIMITS.unsent) {
        throw new RemoteError('TOO_MANY', 'too many attachments not sent yet', { limit: LIMITS.unsent })
      }
      if (this.#storedBytes(sessionId) + (size as number) > LIMITS.perSession) {
        throw new RemoteError('TOO_LARGE', 'this session holds too many attachments', { limit: LIMITS.perSession })
      }
      id = this.#newId()
      upload = { sessionId, name: p.name, size: size as number, received: 0 }
      fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.#inside(pendingDir, `${id}.partial`), '', { mode: 0o600 })
      this.#uploads.set(id, upload)
    } else {
      if (typeof p.attachmentId !== 'string') throw new RemoteError('BAD_PARAMS', '`attachmentId` must be a string')
      id = p.attachmentId
      const known = this.#uploads.get(id)
      if (!known || known.sessionId !== sessionId) throw new RemoteError('NOT_FOUND', 'no such upload in progress')
      upload = known
      if (offset !== upload.received) {
        throw new RemoteError('BAD_PARAMS', 'a chunk must start where the last one ended', { received: upload.received })
      }
    }
    if (upload.received + bytes.length > upload.size) {
      throw new RemoteError('BAD_PARAMS', 'the chunk runs past the declared size', { received: upload.received })
    }

    const partial = this.#inside(pendingDir, `${id}.partial`)
    fs.appendFileSync(partial, bytes, { mode: 0o600 })
    upload.received += bytes.length
    if (upload.received < upload.size) return { attachmentId: id, received: upload.received, complete: false }

    this.#uploads.delete(id)
    const content = fs.readFileSync(partial)
    const kind = kindOf(content)
    if (kind === null) {
      fs.rmSync(partial, { force: true })
      throw new RemoteError('UNSUPPORTED_TYPE', 'only images (PNG, JPEG, GIF, WebP), PDF and UTF-8 text are accepted')
    }
    fs.renameSync(partial, this.#inside(pendingDir, `${id}-${storedName(upload.name, kind)}`))
    return { attachmentId: id, received: upload.received, complete: true }
  }

  /**
   * Takes complete, unsent attachments of this session for one reply. Each must not be reserved by another
   * reply; otherwise `NOT_FOUND` and nothing is taken.
   */
  reserve(sessionId: string, ids: readonly string[]): Reservation {
    const pendingDir = this.#dir(sessionId, 'pending')
    const names = this.#files(pendingDir)
    const found: string[] = []
    for (const id of ids) {
      const name = names.find((candidate) => candidate.startsWith(`${id}-`))
      if (!name || this.#reserved.has(id) || ids.indexOf(id) !== ids.lastIndexOf(id)) {
        throw new RemoteError('NOT_FOUND', `no unsent attachment ${id}`)
      }
      found.push(name)
    }
    for (const id of ids) this.#reserved.add(id)
    let done = false
    const finish = () => {
      done = true
      for (const id of ids) this.#reserved.delete(id)
    }
    const sentDir = this.#dir(sessionId, 'sent')
    const paths = found.map((name) => this.#inside(sentDir, name))
    return {
      paths,
      commit: () => {
        if (done) return
        fs.mkdirSync(sentDir, { recursive: true, mode: 0o700 })
        found.forEach((name, index) => fs.renameSync(this.#inside(pendingDir, name), paths[index]))
        finish()
      },
      release: () => {
        if (!done) finish()
      },
    }
  }

  /** The session was closed: its attachments go. */
  removeSession(sessionId: string): void {
    for (const [id, upload] of this.#uploads) if (upload.sessionId === sessionId) this.#uploads.delete(id)
    try {
      fs.rmSync(path.dirname(this.#dir(sessionId, 'pending')), { recursive: true, force: true })
    } catch {
      // nothing to remove
    }
  }

  /**
   * At startup: directories of sessions the desktop no longer has, uploads that were in progress (their state
   * did not survive), unsent attachments older than `UNSENT_MS`, and anything older than `KEEP_MS`.
   */
  sweep(knownSessions: ReadonlySet<string>): void {
    for (const sessionId of this.#files(this.root)) {
      if (!knownSessions.has(sessionId)) {
        fs.rmSync(path.join(this.root, sessionId), { recursive: true, force: true })
        continue
      }
      for (const part of ['pending', 'sent'] as const) {
        const dir = this.#dir(sessionId, part)
        for (const name of this.#files(dir)) {
          const file = path.join(dir, name)
          try {
            const age = this.#now() - fs.statSync(file).mtimeMs
            const stale = name.endsWith('.partial') || age > KEEP_MS || (part === 'pending' && age > UNSENT_MS)
            if (stale) fs.rmSync(file, { force: true })
          } catch {
            // gone meanwhile
          }
        }
      }
    }
  }
}

let store: AttachmentStore | null = null

/** Sets the store's root once, at startup (`<userData>/remote-attachments`). */
export function configureAttachments(userDataPath: string): AttachmentStore {
  store = new AttachmentStore(path.join(userDataPath, 'remote-attachments'))
  return store
}

export function attachmentStore(): AttachmentStore | null {
  return store
}

/**
 * The injection contribution: permission to read the whole store, while agent event reporting is enabled
 * (without the wait state a reply is refused anyway, and no settings should be passed on this account).
 */
export function prepareAttachmentAccess(enabled: boolean): InjectionContribution | null {
  if (!enabled || !store) return null
  return { settings: { permissions: { allow: [`Read(/${store.root}/**)`] } }, env: {} }
}
