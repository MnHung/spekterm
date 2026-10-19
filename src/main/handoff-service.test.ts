import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, describe } from 'node:test'

import type { ReportDecision } from './handoff-completion'
import { HANDOFF_ADAPTER, MAX_REPORT_LENGTH } from './handoff-delivery'
import { isPermanentRejection } from './intake-rejection'
import { configureHandoff, outboxDir, prepareOutbox, resetHandoffState } from './handoff-outbox'
import { ENDED_SOURCE_ID, GLOBAL_SOURCE_ID, HandoffService, type HandoffServiceDeps } from './handoff-service'
import { MAX_BODY_LENGTH, MAX_FIRST_PARTY_BODY_LENGTH } from './intake-schema'
import { IntakeService } from './intake-service'
import { rescanLog, rescanOnce, silentWatcher } from './intake-source.testkit'
import { testOpener } from './handoff-opener.testkit'
import { IntakeStore } from './intake-store'

interface Harness {
  service: IntakeService
  store: IntakeStore
  handoff: HandoffService
  autoAccepted: { id: string; folderId: string }[]
  file: (sessionId: string, name: string, payload: unknown) => string
}

function harness(options: {
  sources?: Record<string, { folderId: string | null; label: string; title?: string }>
  candidates?: { id: string; name: string; path: string }[]
  eventsEnabled?: boolean
  /** 完成報告的採納（`handoff-completion`）。每一次呼叫都記下來。 */
  report?: (sessionId: string, summary: string, identity: string) => ReportDecision
  control?: HandoffServiceDeps['control']
  sourceTesting?: HandoffServiceDeps['sourceTesting']
} = {}): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-service-'))
  resetHandoffState()
  configureHandoff(base)
  const archive = path.join(base, 'intake')
  fs.mkdirSync(archive, { recursive: true })
  const store = new IntakeStore(path.join(base, 'intake.json'))
  const service = new IntakeService({ store, archiveRoot: archive })
  const autoAccepted: { id: string; folderId: string }[] = []
  const candidates = (): { id: string; name: string; path: string }[] =>
    options.candidates ?? [{ id: 'f2', name: 'beta', path: '/repos/beta' }]
  const opener = testOpener(service, candidates, (_adapter, id, folderId) => autoAccepted.push({ id, folderId }), {
    eventsEnabled: () => options.eventsEnabled !== false,
  })
  const handoff = new HandoffService({
    service,
    sourceOf: (sessionId) => options.sources?.[sessionId] ?? null,
    candidates,
    agentEventsEnabled: () => options.eventsEnabled !== false,
    onDelivered: () => opener.tick(),
    ...(options.report ? { acceptReport: options.report } : {}),
    ...(options.control ? { control: options.control } : {}),
    ...(options.sourceTesting ? { sourceTesting: options.sourceTesting } : {}),
  })
  return {
    service,
    store,
    handoff,
    autoAccepted,
    file: (sessionId, name, payload) => {
      prepareOutbox(sessionId)
      const target = path.join(outboxDir(sessionId), name)
      fs.writeFileSync(target, typeof payload === 'string' ? payload : JSON.stringify(payload))
      return target
    },
  }
}

const good = { target: 'beta', title: 'hand off', body: 'do the thing' }
const sources = { s1: { folderId: 'f1', label: 'alpha' } }

test('合法的交接進收件匣，且被請求自動接受', async () => {
  const h = harness({ sources })
  const file = h.file('s1', 'a.json', good)
  const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(outcome.ok, true)
  assert.equal(h.autoAccepted.length, 1)
  assert.equal(h.autoAccepted[0].folderId, 'f2')
})

test('來源取自落點的目錄名，投遞內容自稱的來源被忽略', async () => {
  const h = harness({ sources })
  const file = h.file('s1', 'a.json', { ...good, origin: { kind: 'slack', id: 'EVIL', label: 'evil' } })
  await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  const record = h.store.list()[0]
  assert.equal(record.content?.verified.originId, 'f1')
  assert.equal(record.content?.verified.originKind, 'session')
})

test('投遞內容自稱的目標不被採信 —— 目標只由查表決定', async () => {
  const h = harness({
    sources,
    candidates: [
      { id: 'f2', name: 'beta', path: '/repos/beta' },
      { id: 'f9', name: 'secret', path: '/repos/secret' },
    ],
  })
  const file = h.file('s1', 'a.json', { ...good, targetFolderId: 'f9' })
  await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(h.store.list()[0].content?.verified.targetFolderId, 'f2')
  assert.equal(h.autoAccepted[0].folderId, 'f2')
})

test('全域 session 的交接照常處理', async () => {
  const h = harness({ sources: { g: { folderId: null, label: 'Global' } } })
  const file = h.file('g', 'a.json', good)
  await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(h.store.list()[0].content?.verified.originId, GLOBAL_SOURCE_ID)
})

test('來源 session 已結束時仍然建立 session，只是來源標示為已結束', async () => {
  const h = harness({ sources: {} })
  const file = h.file('gone', 'a.json', good)
  const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(outcome.ok, true)
  assert.equal(h.store.list()[0].content?.verified.originId, ENDED_SOURCE_ID)
  assert.equal(h.autoAccepted.length, 1)
})

test('同一份內容投遞兩次只得到一則、只請求一次自動接受', async () => {
  const h = harness({ sources })
  const first = h.file('s1', 'a.json', good)
  const contents = fs.readFileSync(first, 'utf8')
  await h.handoff.deliverFile(contents, first)
  await h.handoff.deliverFile(contents, first)

  assert.equal(h.store.list().length, 1)
  assert.equal(h.autoAccepted.length, 1)
})

test('同一個檔名、不同內容 ⇒ 兩則交接（識別碼取自內容而非檔名）', async () => {
  const h = harness({ sources })
  const first = h.file('s1', 'a.json', good)
  await h.handoff.deliverFile(fs.readFileSync(first, 'utf8'), first)
  const second = path.join(outboxDir('s1'), 'a.json')
  fs.writeFileSync(second, JSON.stringify({ ...good, body: 'a different thing' }))
  await h.handoff.deliverFile(fs.readFileSync(second, 'utf8'), second)

  assert.equal(h.store.list().length, 2)
  assert.equal(h.autoAccepted.length, 2)
})

test('目標查無 ⇒ 拒絕、可見、不建立 session', async () => {
  const h = harness({ sources })
  const file = h.file('s1', 'a.json', { ...good, target: 'nowhere' })
  const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'TARGET_NOT_FOUND')
  assert.equal(outcome.notify, true)
  assert.equal(h.autoAccepted.length, 0)
  assert.equal(h.service.notices()[0].code, 'TARGET_NOT_FOUND')
})

test('目標歧義 ⇒ 拒絕並帶出候選', async () => {
  const h = harness({
    sources,
    candidates: [
      { id: 'f1', name: 'common', path: '/a/common' },
      { id: 'f2', name: 'common', path: '/b/common' },
    ],
  })
  const file = h.file('s1', 'a.json', { ...good, target: 'common' })
  const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(outcome.code, 'TARGET_AMBIGUOUS')
  assert.match(String(outcome.detail), /\/a\/common/)
  assert.equal(h.autoAccepted.length, 0)
})

test('寫到一半的投遞不被消費，也不發通知', async () => {
  const h = harness({ sources })
  const file = h.file('s1', 'a.json', '{"target":"beta","bo')
  const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(outcome.consume, false)
  assert.equal(outcome.notify, false)
  assert.deepEqual(h.service.notices(), [])
})

test('事件回報關閉時不建立 session，且可見地說明', async () => {
  const h = harness({ sources, eventsEnabled: false })
  const file = h.file('s1', 'a.json', good)
  const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(outcome.code, 'PREFILL_UNAVAILABLE')
  assert.equal(outcome.notify, true)
  assert.equal(h.store.list().length, 0)
  assert.equal(h.autoAccepted.length, 0)
})

test('沒有上限：同一個來源連續交接，每一則都到達即建立 session（handoff-session-lifecycle）', async () => {
  const h = harness({ sources })
  const bodies = Array.from({ length: 12 }, (_, i) => `body-${i}`)
  for (const body of bodies) {
    const file = h.file('s1', `${body}.json`, { ...good, body })
    await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
  }
  assert.equal(h.autoAccepted.length, bodies.length)
})

test('不在 <root>/<sessionId>/ 正下方的檔案不是交接', async () => {
  const h = harness({ sources })
  const outcome = await h.handoff.deliverFile(JSON.stringify(good), '/somewhere/else/a.json')
  assert.equal(outcome.ok, false)
  assert.equal(h.autoAccepted.length, 0)
})

/**
 * **永久／暫時的分類不決定 `consume`。**
 *
 * 這一則的代碼是 `MALFORMED`，而 `MALFORMED` 在 `isPermanentRejection` 裡是**暫時性**的
 * —— 但它仍然必須被消費掉，否則它每次掃描都再被讀一遍，永遠。
 *
 * 兩者綁在一起的實作會把這條路改壞，而症狀是「一個放錯位置的檔案讓每一輪掃描都多走一趟」，
 * 沒有任何東西會紅。
 */
test('放錯位置的投遞雖為暫時性失敗，仍然被消費 —— 分類不決定 consume', async () => {
  const h = harness({ sources })
  const outcome = await h.handoff.deliverFile(JSON.stringify(good), '/somewhere/else/a.json')

  assert.equal(outcome.code, 'MALFORMED')
  assert.equal(isPermanentRejection({ code: 'MALFORMED', notify: outcome.notify }), false)
  assert.equal(outcome.consume, true, '暫時性失敗，但必須消費')
})

test('adapter 恆為 handoff —— 去重的主鍵是 (adapter, id)', async () => {
  const h = harness({ sources })
  const file = h.file('s1', 'a.json', good)
  await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
  assert.equal(h.store.list()[0].adapter, HANDOFF_ADAPTER)
})

test('落點的清除發生在內容處理完之後 —— 投遞後立刻結束 session，那則交接仍被處理', async () => {
  const h = harness({ sources })
  h.file('s1', 'a.json', good)
  await h.handoff.start()

  await h.handoff.endSession('s1')

  assert.equal(h.store.list().length, 1)
  assert.equal(h.autoAccepted.length, 1)
  assert.equal(fs.existsSync(outboxDir('s1')), false)
  await h.handoff.dispose()
})

test('交接受待處理總量上限約束 —— 豁免它等於推開一道保護收件匣的閘', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-cap-'))
  resetHandoffState()
  configureHandoff(base)
  const archive = path.join(base, 'intake')
  fs.mkdirSync(archive, { recursive: true })
  const store = new IntakeStore(path.join(base, 'intake.json'))
  const service = new IntakeService({ store, archiveRoot: archive, maxPending: 1 })
  const accepted: string[] = []
  const candidates = (): { id: string; name: string; path: string }[] => [{ id: 'f2', name: 'beta', path: '/repos/beta' }]
  const opener = testOpener(service, candidates, (_a, id) => accepted.push(id))
  const handoff = new HandoffService({
    service,
    sourceOf: () => ({ folderId: 'f1', label: 'alpha' }),
    candidates,
    agentEventsEnabled: () => true,
    onDelivered: () => opener.tick(),
  })
  prepareOutbox('s1')
  const write = (name: string, body: string): string => {
    const target = path.join(outboxDir('s1'), name)
    fs.writeFileSync(target, JSON.stringify({ ...good, body }))
    return target
  }

  const first = write('one.json', 'one')
  await handoff.deliverFile(fs.readFileSync(first, 'utf8'), first)
  const second = write('two.json', 'two')
  const outcome = await handoff.deliverFile(fs.readFileSync(second, 'utf8'), second)

  assert.equal(outcome.code, 'CAPACITY')
  // **暫時性拒絕 ⇒ 不消費** —— 投遞檔留在落點等上限解除（既有行為）。
  assert.equal(outcome.consume, false)
  assert.equal(accepted.length, 1)
})

/**
 * **這一組取代了原本的「不因投遞者是自己的 agent 而放寬」。**
 *
 * 那條測試保護的是一道**在這條路徑上不存在**的閘門：`MAX_BODY_LENGTH` 的全部依據是
 * 「使用者要逐字讀完才能按下接受」，而交接到達即建立 session，不經那道閘。
 * 依據換成「接手的 agent 要能一次讀完交付的整份內容」之後，上限仍然存在 —— 只是換了一個
 * 數字與一個相反方向的失效模式（調大不是讓人累，是讓交付靜默地只到一半）。
 *
 * **兩條都要有**：只留上面那條，一個把上限整個拿掉的實作照樣全綠。
 */
test('交接的本文不受第三方那個上限約束 —— 它保護的閘門在這條路徑上不存在', async () => {
  const h = harness({ sources })
  const file = h.file('s1', 'a.json', { ...good, body: 'x'.repeat(MAX_BODY_LENGTH + 1) })
  const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(outcome.ok, true)
  assert.equal(h.store.list().length, 1)
  assert.equal(h.autoAccepted.length, 1)
})

test('交接的本文仍受它自己那個上限約束 —— 依據換了，上限沒有消失', async () => {
  const h = harness({ sources })
  const file = h.file('s1', 'a.json', { ...good, body: 'x'.repeat(MAX_FIRST_PARTY_BODY_LENGTH + 1) })
  const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(outcome.code, 'TOO_LONG')
  assert.equal(h.store.list().length, 0)
  assert.equal(h.autoAccepted.length, 0)
})

test('交接標記為「本文非第三方撰寫」—— 它決定交給 agent 的是哪一種 prompt', async () => {
  const h = harness({ sources })
  const file = h.file('s1', 'a.json', good)
  await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(h.store.list()[0].content?.verified.firstPartyBody, true)
})

test('投遞內容自稱 firstPartyBody 不被採信', async () => {
  const h = harness({ sources })
  // 共用落點那一側沒有 provenance ⇒ 這個欄位表達不出來；這裡驗的是它連在交接的 payload 裡
  // 也只是一個被丟棄的未知欄位（值由接收端決定）。
  const file = h.file('s1', 'a.json', { ...good, firstPartyBody: false })
  await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)

  assert.equal(h.store.list()[0].content?.verified.firstPartyBody, true)
})

// ---- 來源（handoff-lineage）

const P = 'c463620e-cfbf-40e4-9732-685d0ea94b89'

async function sourceAfter(sources: Record<string, { folderId: string | null; label: string; title?: string }>, from = P, payload: unknown = good) {
  const h = harness({ sources })
  const file = h.file(from, 'a.json', payload)
  await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
  return h.store.list()[0]?.content?.verified.source
}

test('來源：folder 的 session ⇒ 識別碼、folder 名稱與當下的標籤', async () => {
  assert.deepEqual(await sourceAfter({ [P]: { folderId: 'f1', label: 'alpha', title: 'Session 交接' } }), {
    sessionId: P,
    origin: { kind: 'folder', folderId: 'f1', folderName: 'alpha' },
    title: 'Session 交接',
  })
})

test('來源：全域 session ⇒ 全域，不含字面名稱', async () => {
  const source = await sourceAfter({ [P]: { folderId: null, label: 'Global' } })
  assert.deepEqual(source, { sessionId: P, origin: { kind: 'global' } })
  assert.ok(!JSON.stringify(source).includes('Global'))
})

test('來源：攝入時已結束 ⇒ 未知（不是全域），沒有快照', async () => {
  assert.deepEqual(await sourceAfter({}), { sessionId: P, origin: { kind: 'unknown' } })
})

test('來源：投遞內容自稱的來源不影響它', async () => {
  const source = await sourceAfter(
    { [P]: { folderId: 'f1', label: 'alpha' } },
    P,
    { ...good, source: { sessionId: '11111111-2222-3333-4444-555555555555', origin: { kind: 'global' } } },
  )
  assert.equal(source?.sessionId, P)
  assert.equal(source?.origin.kind, 'folder')
})

test('來源：落點目錄名不是 UUID ⇒ 不帶來源，交接照常被攝入', async () => {
  const h = harness({ sources: { s1: { folderId: 'f1', label: 'alpha' } } })
  const file = h.file('s1', 'a.json', good)
  const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
  assert.equal(outcome.ok, true)
  assert.equal(h.store.list()[0]?.content?.verified.source, undefined)
})

test('來源：超長且含控制字元的標題被正規化截斷，交接照常被攝入', async () => {
  const h = harness({ sources: { [P]: { folderId: 'f1', label: 'alpha', title: `a\u202e${'x'.repeat(500)}` } } })
  const file = h.file(P, 'a.json', good)
  const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
  assert.equal(outcome.ok, true)
  const title = h.store.list()[0]?.content?.verified.source?.title ?? ''
  assert.ok(!title.includes('\u202e'))
  assert.ok([...title].length <= 200)
})

// ── 完成報告（handoff-session-lifecycle） ─────────────────────────────────────

describe('完成報告經同一個落點送達，以種類欄位區分', () => {
  const seen: { sessionId: string; summary: string }[] = []
  const accepting = (decision: ReportDecision) => (sessionId: string, summary: string) => {
    seen.push({ sessionId, summary })
    return decision
  }

  test('被採納的報告不進收件匣、不留痕跡，且被消費', async () => {
    seen.length = 0
    const h = harness({ sources, report: accepting('accepted') })
    const file = h.file('s1', 'r.json', { kind: 'report', summary: 'Done: fixed login' })
    const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.consume, true)
    assert.deepEqual(seen, [{ sessionId: 's1', summary: 'Done: fixed login' }])
    assert.equal(h.store.list().length, 0)
    assert.deepEqual(h.service.notices(), [])
    assert.equal(h.autoAccepted.length, 0)
  })

  test('摘要經攝入正規化（零寬與雙向控制字元被移除）', async () => {
    seen.length = 0
    const h = harness({ sources, report: accepting('accepted') })
    const file = h.file('s1', 'r.json', { kind: 'report', summary: 'ok\u200b\u202e done' })
    await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
    assert.equal(seen[0]?.summary, 'ok done')
  })

  test('不認得的種類被拒絕且可見', async () => {
    const h = harness({ sources, report: accepting('accepted') })
    const file = h.file('s1', 'x.json', { kind: 'status', summary: 'x' })
    const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
    assert.equal(outcome.ok, false)
    assert.equal(h.service.notices()[0]?.code, 'FIELD_TYPE')
  })

  test('摘要過長被拒絕而非截斷', async () => {
    // **對照組**：把超長改成截斷後採納 → 採納的呼叫會出現，這條必須變紅。
    seen.length = 0
    const h = harness({ sources, report: accepting('accepted') })
    const file = h.file('s1', 'r.json', { kind: 'report', summary: 'x'.repeat(MAX_REPORT_LENGTH + 1) })
    await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
    assert.equal(seen.length, 0)
    assert.equal(h.service.notices()[0]?.code, 'TOO_LONG')
  })

  test('空白摘要被拒絕且可見', async () => {
    seen.length = 0
    const h = harness({ sources, report: accepting('accepted') })
    const file = h.file('s1', 'r.json', { kind: 'report', summary: '  \u200b ' })
    await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
    assert.equal(seen.length, 0)
    assert.equal(h.service.notices()[0]?.code, 'FIELD_TYPE')
  })

  test('非由交接建立的 session 的報告被拒絕且可見', async () => {
    const h = harness({ sources, report: accepting('not-handoff') })
    const file = h.file('s1', 'r.json', { kind: 'report', summary: 'done' })
    const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
    assert.equal(outcome.ok, false)
    assert.equal(h.service.notices()[0]?.code, 'REPORT_NOT_HANDOFF')
  })

  test('已不存在的 session 的報告被靜默丟棄（消費，但沒有痕跡）', async () => {
    const h = harness({ sources, report: accepting('gone') })
    const file = h.file('s1', 'r.json', { kind: 'report', summary: 'done' })
    const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
    assert.equal(outcome.consume, true)
    assert.deepEqual(h.service.notices(), [])
  })

  test('同一份投遞檔讀兩次，給出的身分相同（讓採納端只採納一次）', async () => {
    const identities: string[] = []
    const h = harness({
      sources,
      report: (_s, _m, identity) => {
        identities.push(identity)
        return 'accepted'
      },
    })
    const file = h.file('s1', 'r.json', { kind: 'report', summary: 'done' })
    const contents = fs.readFileSync(file, 'utf8')
    await h.handoff.deliverFile(contents, file)
    await h.handoff.deliverFile(contents, file)
    assert.equal(identities.length, 2)
    assert.equal(identities[0], identities[1])
  })
})

// ── The periodic re-read of the outboxes (intake-periodic-rescan) ────────────────
//
// Through `HandoffService.start()` — the real wiring — with only the watcher replaced by one that
// reports nothing, and the default interval (it is deliberately not passed through). Auto-accept
// being requested for the target folder is what creates the session, as in the tests above.

describe('the periodic re-read of the outboxes', () => {
  const services: HandoffService[] = []
  const unlocked: string[] = []
  after(async () => {
    for (const dir of unlocked) fs.chmodSync(dir, 0o755)
    for (const service of services) await service.dispose()
  })

  function writeHandoff(sessionId: string, name: string, payload: unknown): string {
    const target = path.join(outboxDir(sessionId), name)
    fs.writeFileSync(target, JSON.stringify(payload))
    return target
  }

  test('A handoff the watcher never reported creates its session', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const log = rescanLog()
    const h = harness({ sources, sourceTesting: { watch: silentWatcher, onRescan: log.onRescan } })
    services.push(h.handoff)
    await h.handoff.start()
    // A session created after the application started: its outbox appears after `start()`.
    prepareOutbox('s1')
    writeHandoff('s1', 'a.json', good)

    await rescanOnce(t, log)

    assert.deepEqual(h.autoAccepted.map((a) => a.folderId), ['f2'])
  })

  test("A restored session's handoff the watcher never reported creates its session", async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const log = rescanLog()
    const h = harness({ sources, sourceTesting: { watch: silentWatcher, onRescan: log.onRescan } })
    services.push(h.handoff)
    // A restored session: its outbox already exists when the application starts.
    prepareOutbox('s1')
    await h.handoff.start()
    writeHandoff('s1', 'a.json', good)

    await rescanOnce(t, log)

    assert.deepEqual(h.autoAccepted.map((a) => a.folderId), ['f2'])
  })

  test('A rejected handoff that cannot be removed is notified once', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const log = rescanLog()
    const h = harness({ sources, sourceTesting: { watch: silentWatcher, onRescan: log.onRescan } })
    services.push(h.handoff)
    const failures: unknown[] = []
    h.service.onFailure((failure) => failures.push(failure))
    prepareOutbox('s1')
    writeHandoff('s1', 'a.json', { ...good, target: 'nowhere' })
    // The file cannot be removed: its directory is read-only. (A root user would bypass this.)
    fs.chmodSync(outboxDir('s1'), 0o555)
    unlocked.push(outboxDir('s1'))

    await h.handoff.start()
    for (let i = 0; i < 3; i += 1) await rescanOnce(t, log)

    assert.equal(failures.length, 1, 'one notification-bearing failure report')
    const traces = h.service.notices().reduce((sum, n) => sum + n.count, 0)
    assert.equal(traces, 1, 'one rejection trace occurrence')
  })
})

describe('session commands (agent-session-control)', () => {
  test('a command kind goes to the control with its source, its identity and the read\'s time', async () => {
    const calls: { source: string; kind: string; identity: string; mtimeMs: number | undefined }[] = []
    const h = harness({
      control: (source, kind, _contents, identity, mtimeMs) => {
        calls.push({ source, kind, identity, mtimeMs })
        return { ok: true, consume: true, notify: false }
      },
    })
    const file = h.file('s1', 'c.json', { kind: 'close', target: 'beta-1a2b' })
    const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file, { mtimeMs: 42, size: 1 })
    assert.equal(outcome.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.source, 's1')
    assert.equal(calls[0]?.kind, 'close')
    assert.equal(calls[0]?.mtimeMs, 42)
    assert.equal(h.store.list().length, 0, 'a command is not an inbox item')
  })

  test('without a control, the command kinds are refused as an unknown kind', async () => {
    const h = harness()
    const file = h.file('s1', 'c.json', { kind: 'hibernate' })
    const outcome = await h.handoff.deliverFile(fs.readFileSync(file, 'utf8'), file)
    assert.equal(outcome.code, 'FIELD_TYPE')
  })
})
