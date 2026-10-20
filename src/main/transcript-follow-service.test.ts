import assert from 'node:assert/strict'
import test from 'node:test'

import type { FSWatcher } from 'chokidar'

import { TranscriptFollower, type FollowUpdate } from './transcript-follow-service'
import type { SkillList } from './transcript-skills'

/** 假 watcher：記下建立參數，並讓測試自己觸發事件。 */
function harness(onSkills?: (skills: SkillList) => void) {
  const files = new Map<string, string>()
  /** 存在的目錄。預設全部存在 —— 只有明確測試「尚不存在」的案例才會限制它。 */
  const exists = new Set<string>()
  const watchers: { target: string; label: string; depth?: number; fire: () => void }[] = []
  const updates: FollowUpdate[] = []
  const closed: string[] = []

  const makeWatcher = ({ target, label, depth }: { target: string; label: string; depth?: number }) => {
    let handler: (() => void) | null = null
    const w = {
      on: (_: string, fn: () => void) => {
        handler = fn
        return w
      },
      close: async () => {
        closed.push(target)
      },
    } as unknown as FSWatcher
    watchers.push({ target, label, depth, fire: () => handler?.() })
    return w
  }

  const follower = new TranscriptFollower('s1', (u) => updates.push(u), {
    makeWatcher,
    statSize: (t) => (files.has(t) ? Buffer.byteLength(files.get(t)!) : null),
    readRange: (t, from, to) => {
      const v = files.get(t)
      return v === undefined ? null : Buffer.from(v, 'utf8').subarray(from, to)
    },
    // 目錄的存在性：`exists` 為空 ⇒ 一律視為存在（多數測試不在乎這件事）。
    exists: (t) => files.has(t) || exists.size === 0 || exists.has(t),
    onSkills,
  })
  return { files, watchers, updates, closed, exists, follower }
}

const rec = (uuid: string, text: string) =>
  `${JSON.stringify({ type: 'user', uuid, timestamp: '2026-09-06T00:00:00.000Z', cwd: '/secret/dir', message: { role: 'user', content: text } })}\n`

/**
 * **紀錄尚不存在是每個新 session 的必經狀態，不是例外。** agent 在使用者講第一句話之前不寫
 * 任何東西。
 *
 * 此前這裡回報 `attaching`，而呈現層把它當成整頁的載入狀態 ⇒ 新 session 沒有輸入框 ⇒
 * 打不了字 ⇒ 紀錄永遠不會出現。**死鎖，且 dogfood 第一分鐘就撞上。**
 *
 * 因此本條斷言的是 `ok`：規格的用語是「呈現層收到**尚無內容**而非錯誤」，而
 * 「尚無內容」與「還沒講話」必須是同一個狀態 —— 呈現層才沒有理由把入口藏起來。
 */
test('紀錄尚不存在 ⇒ ok ＋ 零內容（不是 attaching、不是失敗）；出現後內容送達', () => {
  const h = harness()
  h.follower.relocate('/p/proj/a.jsonl')
  assert.equal(h.updates.at(-1)?.status, 'ok')
  assert.equal(h.updates.at(-1)?.events.length, 0)

  h.files.set('/p/proj/a.jsonl', rec('u1', 'hello'))
  h.watchers[0].fire() // 第一層（目錄）發現它出現了
  const last = h.updates.at(-1)!
  assert.equal(last.status, 'ok')
  assert.equal(last.events.length, 1)
})

test('第一層監看目錄且 depth 0，第二層才監看檔案', () => {
  const h = harness()
  h.files.set('/p/proj/a.jsonl', rec('u1', 'x'))
  h.follower.relocate('/p/proj/a.jsonl')
  assert.deepEqual(
    h.watchers.map((w) => [w.target, w.depth]),
    [
      ['/p/proj', 0],
      ['/p/proj/a.jsonl', undefined],
    ],
  )
})

test('只送出新增的內容，且不重送', () => {
  const h = harness()
  h.files.set('/p/proj/a.jsonl', rec('u1', 'one'))
  h.follower.relocate('/p/proj/a.jsonl')
  h.updates.length = 0

  h.files.set('/p/proj/a.jsonl', rec('u1', 'one') + rec('u2', 'two'))
  h.watchers[1].fire()
  assert.equal(h.updates.length, 1)
  assert.equal(h.updates[0].reset, false)
  assert.deepEqual(h.updates[0].events.map((e) => e.uuid), ['u2'])

  // 大小沒變 ⇒ 不再送出任何東西
  h.watchers[1].fire()
  assert.equal(h.updates.length, 1)
})

test('來源變短時自頭重讀，並要求呈現層清空', () => {
  const h = harness()
  h.files.set('/p/proj/a.jsonl', rec('u1', 'one') + rec('u2', 'two'))
  h.follower.relocate('/p/proj/a.jsonl')
  h.updates.length = 0

  h.files.set('/p/proj/a.jsonl', rec('u9', 'fresh'))
  h.watchers[1].fire()
  const last = h.updates.at(-1)!
  assert.equal(last.reset, true)
  assert.deepEqual(last.events.map((e) => e.uuid), ['u9'])
})

test('讀得到大小卻讀不到內容時明說 unavailable，不呈現為「沒有內容」', () => {
  const updates: FollowUpdate[] = []
  const f = new TranscriptFollower('s1', (u) => updates.push(u), {
    makeWatcher: () =>
      ({ on: () => undefined, close: async () => undefined }) as unknown as FSWatcher,
    statSize: () => 42,
    readRange: () => null,
    exists: () => true,
  })
  f.relocate('/p/proj/a.jsonl')
  assert.equal(updates.at(-1)?.status, 'unavailable')
})

test('relocate 到新的位置後跟進新來源，不停留在舊的', () => {
  const h = harness()
  h.files.set('/p/proj/old.jsonl', rec('old1', 'old'))
  h.follower.relocate('/p/proj/old.jsonl')
  h.files.set('/p/proj/new.jsonl', rec('new1', 'new'))
  h.updates.length = 0

  h.follower.relocate('/p/proj/new.jsonl')
  const last = h.updates.at(-1)!
  assert.equal(last.reset, true)
  assert.deepEqual(last.events.map((e) => e.uuid), ['new1'])
  assert.equal(h.follower.target, '/p/proj/new.jsonl')
})

test('relocate 到同一個位置是無操作（事件每一則都帶位置，多數時候沒變）', () => {
  const h = harness()
  h.files.set('/p/proj/a.jsonl', rec('u1', 'x'))
  h.follower.relocate('/p/proj/a.jsonl')
  const n = h.updates.length
  h.follower.relocate('/p/proj/a.jsonl')
  assert.equal(h.updates.length, n)
})

test('dispose 之後不再送出，且監看被釋放', () => {
  const h = harness()
  h.files.set('/p/proj/a.jsonl', rec('u1', 'x'))
  h.follower.relocate('/p/proj/a.jsonl')
  h.follower.dispose()
  assert.deepEqual(h.closed.sort(), ['/p/proj', '/p/proj/a.jsonl'])

  h.updates.length = 0
  h.files.set('/p/proj/a.jsonl', rec('u1', 'x') + rec('u2', 'y'))
  h.watchers[1].fire()
  assert.equal(h.updates.length, 0)
})

/**
 * **這一條的鑑別力有限度，寫在這裡以免被誤讀。**
 *
 * 它驗的是「relocate 之後跟進仍然運作」—— 與上面那條 relocate 測試高度重疊。真正要防的錯誤是
 * **接線層**把 agent 的「對話結束」事件接到 `dispose()`，而那個決定不在本類別之內：本類別只提供
 * 兩個方法，選哪一個是呼叫端的事。
 *
 * **因此本條不是那條 requirement 的載體。** 載體必須在事件橋接的接線處（tasks 4.21），
 * 斷言「收到對話結束事件之後，新內容仍會送達」。
 */
test('relocate 之後跟進仍然運作（接線層的載體見 tasks 4.21）', () => {
  const h = harness()
  h.files.set('/p/proj/old.jsonl', rec('o1', 'old'))
  h.follower.relocate('/p/proj/old.jsonl')

  // agent 宣告一段對話結束（實測：`/clear` 即會發，而 pty 還活著），隨後帶來新的位置。
  h.files.set('/p/proj/new.jsonl', rec('n1', 'new'))
  h.follower.relocate('/p/proj/new.jsonl')
  h.updates.length = 0

  // 新來源其後的追加仍必須送達 —— 若上一步被實作成拆除，這裡會是 0。
  h.files.set('/p/proj/new.jsonl', rec('n1', 'new') + rec('n2', 'more'))
  h.watchers.at(-1)!.fire()
  assert.deepEqual(h.updates.at(-1)?.events.map((e) => e.uuid), ['n2'])
})

test('送往呈現層的事件不含來源的絕對路徑', () => {
  const h = harness()
  h.files.set('/p/proj/a.jsonl', rec('u1', 'hello'))
  h.follower.relocate('/p/proj/a.jsonl')
  const serialized = JSON.stringify(h.updates.map((u) => u.events))
  assert.ok(!serialized.includes('/secret/dir'), serialized)
})

/**
 * **一個新 session 的專案目錄可能還不存在**（該 repo 從未跑過 agent）。
 *
 * chokidar 對一個父目錄也不存在的目標無從 attach —— watcher 建得起來、不報錯、**永遠不觸發**。
 * 使用者看到的是「內容不會自己更新，切走再切回才有」，因為切回會重跑一次主動讀取。
 *
 * 因此第一層必須落在**最近一個存在的祖先**上。
 */
test('專案目錄尚不存在時，第一層落在最近一個存在的祖先', () => {
  const h = harness()
  // 只有 /p 存在；/p/proj 還沒被建立。
  h.exists.add('/p')
  h.follower.relocate('/p/proj/a.jsonl')
  assert.equal(h.watchers[0].target, '/p')
})

test('專案目錄出現後，第一層下移到它身上', () => {
  const h = harness()
  h.exists.add('/p')
  h.follower.relocate('/p/proj/a.jsonl')
  assert.equal(h.watchers[0].target, '/p')

  h.exists.add('/p/proj')
  h.files.set('/p/proj/a.jsonl', rec('u1', 'hello'))
  h.watchers[0].fire()
  assert.ok(
    h.watchers.some((w) => w.target === '/p/proj'),
    `監看的目標：${h.watchers.map((w) => w.target).join(', ')}`,
  )
  assert.equal(h.updates.at(-1)?.events.length, 1)
})

test('poll() 在監看完全沒有觸發時仍取得新內容', () => {
  const h = harness()
  h.files.set('/p/proj/a.jsonl', rec('u1', 'one'))
  h.follower.relocate('/p/proj/a.jsonl')
  h.updates.length = 0

  // 監看一次都不觸發（模擬「目標尚不存在／網路檔案系統／inode 被換掉」那一整類靜默失效）。
  h.files.set('/p/proj/a.jsonl', rec('u1', 'one') + rec('u2', 'two'))
  h.follower.poll()
  assert.deepEqual(h.updates.at(-1)?.events.map((e) => e.uuid), ['u2'])
})

const skillRec = (names: string[], isInitial: boolean) =>
  `${JSON.stringify({
    type: 'attachment',
    uuid: `l-${names.join('-')}`,
    timestamp: '2026-10-20T00:00:00.000Z',
    attachment: { type: 'skill_listing', content: names.map((n) => `- ${n}: about ${n}`).join('\n'), skillCount: names.length, isInitial, names },
  })}\n`

test('the skill listing: reported after the first read, again on a change only, and as no list on a new transcript', () => {
  const reports: SkillList[] = []
  const h = harness((skills) => reports.push(skills))
  h.files.set('/p/proj/a.jsonl', rec('u1', 'hi') + skillRec(['pdf', 'docx'], true))
  h.follower.relocate('/p/proj/a.jsonl')
  assert.deepEqual(reports, [[{ name: 'pdf', description: 'about pdf' }, { name: 'docx', description: 'about docx' }]])
  assert.equal(h.updates.at(-1)?.events.length, 1, 'the listing is not a view event')

  h.files.set('/p/proj/a.jsonl', h.files.get('/p/proj/a.jsonl')! + rec('u2', 'more'))
  h.follower.poll()
  assert.equal(reports.length, 1, 'an unrelated append reports nothing')

  h.files.set('/p/proj/a.jsonl', h.files.get('/p/proj/a.jsonl')! + skillRec(['probe-new'], false))
  h.follower.poll()
  assert.deepEqual(reports.at(-1)?.map((s) => s.name), ['pdf', 'docx', 'probe-new'])

  h.files.set('/p/proj/b.jsonl', rec('u3', 'after clear'))
  h.follower.relocate('/p/proj/b.jsonl')
  assert.equal(reports.at(-1), null, 'a transcript without a listing has no list')
  assert.equal(reports.length, 3)
})

test('a transcript that does not exist yet reports no list once', () => {
  const reports: SkillList[] = []
  const h = harness((skills) => reports.push(skills))
  h.follower.relocate('/p/proj/new.jsonl')
  h.follower.poll()
  assert.deepEqual(reports, [null])
})
