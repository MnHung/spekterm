import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { AttachmentStore, KEEP_MS, kindOf, LIMITS, storedName, UNSENT_MS } from './remote-attachments'
import { RemoteError } from './remote-frames'

const roots: string[] = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function rig(now = () => Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-'))
  roots.push(root)
  let ids = 0
  const store = new AttachmentStore(root, { now, newId: () => `id${++ids}` })
  return { root, store }
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(700 * 1024, 1)])
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0]), Buffer.alloc(50, 0)])

const code = (fn: () => unknown): { code: string; detail?: unknown } => {
  try {
    fn()
  } catch (error) {
    if (error instanceof RemoteError) return { code: error.code, detail: error.detail }
    throw error
  }
  return { code: 'none' }
}

function upload(store: AttachmentStore, sessionId: string, name: string, content: Buffer, chunk = LIMITS.chunk) {
  let result = store.put(sessionId, { name, size: content.length, offset: 0, data: content.subarray(0, chunk).toString('base64') })
  while (!result.complete) {
    result = store.put(sessionId, {
      name,
      size: content.length,
      offset: result.received,
      data: content.subarray(result.received, result.received + chunk).toString('base64'),
      attachmentId: result.attachmentId,
    })
  }
  return result
}

test('a photo in two chunks becomes an attachment holding exactly the bytes, written 0600', () => {
  const { root, store } = rig()
  const first = store.put('s', { name: 'IMG 1.JPG', size: JPEG.length, offset: 0, data: JPEG.subarray(0, LIMITS.chunk).toString('base64') })
  assert.deepEqual(first, { attachmentId: 'id1', received: LIMITS.chunk, complete: false })
  const second = store.put('s', {
    name: 'ignored', size: 0, offset: LIMITS.chunk, attachmentId: 'id1', data: JPEG.subarray(LIMITS.chunk).toString('base64'),
  })
  assert.equal(second.complete, true)
  const files = fs.readdirSync(path.join(root, 's', 'pending'))
  assert.deepEqual(files, ['id1-IMG_1.JPG'], 'an extension that already matches is kept')
  const file = path.join(root, 's', 'pending', files[0])
  assert.ok(fs.readFileSync(file).equals(JPEG))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('a name with path segments is stored inside the session\'s directory, with no leading dot', () => {
  const { root, store } = rig()
  upload(store, 's', '../../.bashrc', Buffer.from('echo hi\n'))
  const files = fs.readdirSync(path.join(root, 's', 'pending'))
  assert.deepEqual(files, ['id1-bashrc.txt'])
  assert.equal(code(() => store.put('../x', { name: 'a', size: 1, offset: 0, data: 'YQ==' })).code, 'NOT_FOUND')
  assert.equal(fs.existsSync(path.join(root, '..', 'x')), false)
})

test('names: cleaned, clipped, and given the extension the content implies', () => {
  assert.equal(storedName('photo.png', 'txt'), 'photo.png.txt', 'text named like an image')
  assert.equal(storedName('notes', 'txt'), 'notes.txt')
  assert.equal(storedName('notes.md', 'txt'), 'notes.md')
  assert.equal(storedName('scan', 'pdf'), 'scan.pdf')
  assert.equal(storedName('a.jpeg', 'jpg'), 'a.jpeg')
  assert.equal(storedName('a.gif', 'png'), 'a.gif.png')
  assert.equal(storedName('', 'png'), 'attachment.png')
  assert.equal(storedName('...', 'txt'), 'attachment.txt')
  assert.equal(storedName('C:\\Users\\me\\x y.txt', 'txt'), 'x_y.txt')
  assert.equal(storedName('a'.repeat(200), 'txt').length, 84)
})

test('accepted kinds are decided by the bytes', () => {
  assert.equal(kindOf(PNG), 'png')
  assert.equal(kindOf(JPEG), 'jpg')
  assert.equal(kindOf(Buffer.from('GIF89a......')), 'gif')
  assert.equal(kindOf(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp')
  assert.equal(kindOf(Buffer.from('%PDF-1.7\n')), 'pdf')
  assert.equal(kindOf(Buffer.from('plain text, ünïcode ✓\n')), 'txt')
  assert.equal(kindOf(ELF), null)
  assert.equal(kindOf(Buffer.from([0xc3, 0x28])), null, 'invalid UTF-8')
})

test('a binary that is not an accepted kind is refused and nothing remains', () => {
  const { root, store } = rig()
  assert.equal(code(() => upload(store, 's', 'photo.png', ELF)).code, 'UNSUPPORTED_TYPE')
  assert.deepEqual(fs.readdirSync(path.join(root, 's', 'pending')), [])
})

test('limits: chunk, file, unsent count and the session total', () => {
  const { store } = rig()
  assert.deepEqual(code(() => store.put('s', { name: 'big', size: 11 * 1024 * 1024, offset: 0, data: '' })), {
    code: 'TOO_LARGE', detail: { limit: LIMITS.file },
  })
  assert.equal(code(() => store.put('s', { name: 'c', size: LIMITS.file, offset: 0, data: Buffer.alloc(LIMITS.chunk + 1).toString('base64') })).code, 'TOO_LARGE')
  for (let i = 0; i < LIMITS.unsent; i += 1) upload(store, 's', `n${i}`, Buffer.from('x'))
  assert.equal(code(() => store.put('s', { name: 'one more', size: 1, offset: 0, data: 'eA==' })).code, 'TOO_MANY')

  // Uploads in progress count toward the unsent limit as well.
  const other = rig()
  for (let i = 0; i < LIMITS.unsent; i += 1) other.store.put('u', { name: `f${i}`, size: LIMITS.file, offset: 0, data: '' })
  assert.equal(code(() => other.store.put('u', { name: 'x', size: 1, offset: 0, data: '' })).code, 'TOO_MANY')
})

test('the per-session total counts sent attachments too', () => {
  const { root, store } = rig()
  fs.mkdirSync(path.join(root, 's', 'sent'), { recursive: true })
  fs.writeFileSync(path.join(root, 's', 'sent', 'old-big.bin'), Buffer.alloc(1))
  fs.truncateSync(path.join(root, 's', 'sent', 'old-big.bin'), LIMITS.perSession - 10)
  assert.deepEqual(code(() => store.put('s', { name: 'x', size: 20, offset: 0, data: '' })), {
    code: 'TOO_LARGE', detail: { limit: LIMITS.perSession },
  })
})

test('a chunk out of order is refused with the amount received, and the content is unchanged', () => {
  const { root, store } = rig()
  const first = store.put('s', { name: 'a.txt', size: 6, offset: 0, data: Buffer.from('abc').toString('base64') })
  assert.deepEqual(code(() => store.put('s', { name: 'a.txt', size: 6, offset: 1, data: 'eHl6', attachmentId: first.attachmentId })), {
    code: 'BAD_PARAMS', detail: { received: 3 },
  })
  assert.equal(fs.readFileSync(path.join(root, 's', 'pending', 'id1.partial'), 'utf8'), 'abc')
  assert.equal(code(() => store.put('s', { name: 'a', size: 6, offset: 3, data: 'eHl6eHl6', attachmentId: first.attachmentId })).code, 'BAD_PARAMS', 'past the size')
  assert.equal(code(() => store.put('other', { name: 'a', size: 6, offset: 3, data: 'eHl6', attachmentId: first.attachmentId })).code, 'NOT_FOUND')
})

test('a reservation takes an attachment once, moves it on commit, and releases it on failure', () => {
  const { root, store } = rig()
  const a = upload(store, 's', 'a.png', PNG).attachmentId
  const b = upload(store, 's', 'b.txt', Buffer.from('b')).attachmentId
  const taken = store.reserve('s', [a])
  assert.equal(code(() => store.reserve('s', [a])).code, 'NOT_FOUND', 'two sends naming one')
  assert.equal(code(() => store.reserve('other', [b])).code, 'NOT_FOUND', 'another session\'s')
  assert.equal(code(() => store.reserve('s', [b, b])).code, 'NOT_FOUND', 'named twice')
  assert.equal(code(() => store.reserve('s', ['nope'])).code, 'NOT_FOUND')
  assert.deepEqual(taken.paths, [path.join(root, 's', 'sent', 'id1-a.png')])
  taken.commit()
  assert.ok(fs.existsSync(taken.paths[0]))
  assert.equal(code(() => store.reserve('s', [a])).code, 'NOT_FOUND', 'already sent, also after a restart')
  const released = store.reserve('s', [b])
  released.release()
  assert.equal(store.reserve('s', [b]).paths.length, 1, 'a failed send leaves it unsent')
  assert.equal(code(() => new AttachmentStore(root).reserve('s', [a])).code, 'NOT_FOUND', 'sent is on disk')
})

test('an upload not finished is not sendable', () => {
  const { store } = rig()
  const partial = store.put('s', { name: 'a.txt', size: 6, offset: 0, data: Buffer.from('abc').toString('base64') })
  assert.equal(code(() => store.reserve('s', [partial.attachmentId])).code, 'NOT_FOUND')
})

test('sweeps: unsent after 24 hours on the next upload; at startup unknown sessions, partials and old files', () => {
  let now = Date.now()
  const { root, store } = rig(() => now)
  upload(store, 's', 'a.txt', Buffer.from('a'))
  const file = path.join(root, 's', 'pending', 'id1-a.txt')
  const old = new Date(now - UNSENT_MS - 1000)
  fs.utimesSync(file, old, old)
  upload(store, 's', 'b.txt', Buffer.from('b'))
  assert.equal(fs.existsSync(file), false)

  store.put('s', { name: 'c.txt', size: 5, offset: 0, data: 'Yw==' })
  fs.mkdirSync(path.join(root, 's', 'sent'), { recursive: true })
  const sentOld = path.join(root, 's', 'sent', 'x-old.txt')
  const sentNew = path.join(root, 's', 'sent', 'x-new.txt')
  fs.writeFileSync(sentOld, 'o')
  fs.writeFileSync(sentNew, 'n')
  const older = new Date(now - KEEP_MS - 1000)
  fs.utimesSync(sentOld, older, older)
  fs.mkdirSync(path.join(root, 'gone', 'pending'), { recursive: true })
  now += 1
  new AttachmentStore(root, { now: () => now }).sweep(new Set(['s']))
  assert.equal(fs.existsSync(path.join(root, 'gone')), false)
  assert.equal(fs.existsSync(sentOld), false)
  assert.equal(fs.existsSync(sentNew), true)
  assert.deepEqual(fs.readdirSync(path.join(root, 's', 'pending')), ['id2-b.txt'], 'the partial is gone, the fresh one kept')
})

test('closing a session removes its directory; nothing else does', () => {
  const { root, store } = rig()
  upload(store, 's', 'a.txt', Buffer.from('a'))
  upload(store, 't', 'a.txt', Buffer.from('a'))
  store.removeSession('s')
  assert.equal(fs.existsSync(path.join(root, 's')), false)
  assert.equal(fs.existsSync(path.join(root, 't')), true)
})
