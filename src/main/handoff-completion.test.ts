import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { WaitValue } from '../shared/lineage/lifecycle'
import { HandoffCompletion } from './handoff-completion'
import { lifecycleViewOf } from './handoff-lifecycle-view'
import { SessionStore } from './session-store'

const PARENT = 'c463620e-cfbf-40e4-9732-685d0ea94b89'
const CHILD = '5b0a3c1e-2f4d-4a6b-8c9d-0e1f2a3b4c5d'
const PLAIN = '7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b'

let dir: string
let sessions: SessionStore
let subscribers: Map<string, (snapshot: { state: WaitValue }) => void>
let changes: string[]
let reported: { sessionId: string; title: string; summary: string }[]
let clock: number
let completion: HandoffCompletion

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), 'handoff-completion-'))
  sessions = new SessionStore(path.join(dir, 'sessions.json'), path.join(dir, 'sessions'))
  sessions.load()
  sessions.addProvisional({
    id: CHILD,
    folderId: 'f2',
    spawnTarget: 'claude',
    lineage: { parentId: PARENT, origin: { kind: 'global' }, brief: { title: 'T', receivedAt: 0 } },
  })
  sessions.writeHandoffBrief(CHILD, { body: 'the handoff' })
  sessions.addProvisional({ id: PLAIN, folderId: 'f1', spawnTarget: 'claude' })
  subscribers = new Map()
  changes = []
  reported = []
  clock = 1_000
  completion = new HandoffCompletion({
    sessions,
    subscribe: (sessionId, fn) => {
      subscribers.set(sessionId, fn)
      return () => subscribers.delete(sessionId)
    },
    now: () => clock++,
    onChange: (sessionId) => changes.push(sessionId),
    onReported: (sessionId, title, summary) => reported.push({ sessionId, title, summary }),
  })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const tick = (state: WaitValue): void => subscribers.get(CHILD)?.({ state })
const completionOf = (id: string) => sessions.view().find((v) => v.session.id === id)?.session.completion

describe('採納完成報告（handoff-completion）', () => {
  it('由交接建立的 session ⇒ 採納：結果存進交接單、本文保留、狀態為已完成', () => {
    assert.equal(completion.acceptReport(CHILD, 'fixed it', 'id-1'), 'accepted')
    const brief = sessions.readHandoffBrief(CHILD)
    assert.equal(brief?.body, 'the handoff')
    assert.equal(brief?.report?.summary, 'fixed it')
    assert.equal(completionOf(CHILD)?.settled, false)
    assert.deepEqual(changes, [CHILD])
  })

  it('非由交接建立 ⇒ not-handoff；不存在 ⇒ gone', () => {
    assert.equal(completion.acceptReport(PLAIN, 'x', 'id-1'), 'not-handoff')
    assert.equal(completion.acceptReport('d0d0d0d0-0000-4000-8000-000000000000', 'x', 'id-1'), 'gone')
    assert.equal(completionOf(PLAIN), undefined)
  })

  it('同一份投遞檔只採納一次 —— 第二次不會把已落定的狀態重設回未落定', () => {
    completion.track(CHILD)
    completion.acceptReport(CHILD, 'done', 'same')
    tick('ready')
    assert.equal(completionOf(CHILD)?.settled, true)
    assert.equal(completion.acceptReport(CHILD, 'done', 'same'), 'duplicate')
    assert.equal(completionOf(CHILD)?.settled, true)
  })

  it('後到的報告取代先前的', () => {
    completion.acceptReport(CHILD, 'S1', 'a')
    completion.acceptReport(CHILD, 'S2', 'b')
    assert.equal(sessions.readHandoffBrief(CHILD)?.report?.summary, 'S2')
  })

  it('沒有交接單的交接 session（本 change 之前建立的）也能回報完成', () => {
    const OLD = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
    sessions.addProvisional({ id: OLD, folderId: 'f2', spawnTarget: 'claude', lineage: { parentId: PARENT, origin: { kind: 'global' } } })
    assert.equal(completion.acceptReport(OLD, 'done', 'x'), 'accepted')
    assert.equal(sessions.readHandoffBrief(OLD)?.report?.summary, 'done')
    assert.equal(sessions.readHandoffBrief(OLD)?.body, undefined)
  })
})

describe('生命週期隨等待狀態推進（handoff-completion）', () => {
  it('只追蹤帶來源的 session', () => {
    completion.track(PLAIN)
    completion.track(CHILD)
    assert.deepEqual([...subscribers.keys()], [CHILD])
  })

  it('報告之後：忙碌（回送訊息）→ 就緒 ⇒ 仍為已完成；其後忙碌 ⇒ 重新開始', () => {
    completion.track(CHILD)
    completion.acceptReport(CHILD, 'done', 'a')
    tick('busy')
    tick('ready')
    assert.equal(lifecycleViewOf(sessions).find((v) => v.sessionId === CHILD)?.state, 'done')
    tick('busy')
    assert.equal(typeof completionOf(CHILD)?.reopenedAt, 'number')
  })

  it('採納之前的輪詢不影響任何東西；採納之後第一次輪詢就是就緒 ⇒ 落定', () => {
    completion.track(CHILD)
    tick('ready')
    assert.equal(completionOf(CHILD), undefined)
    completion.acceptReport(CHILD, 'done', 'a')
    tick('ready')
    assert.equal(completionOf(CHILD)?.settled, true)
  })

  it('每次輪詢值沒變且狀態沒變時不通知（不每 400ms 重寫關係檔）', () => {
    completion.track(CHILD)
    tick('ready')
    const before = changes.length
    tick('ready')
    tick('ready')
    assert.equal(changes.length, before)
  })

  it('退訂之後不再推進', () => {
    completion.track(CHILD)
    completion.untrack(CHILD)
    assert.equal(subscribers.size, 0)
  })

  it('投影：已完成者附摘要；未完成者只有狀態；沒有來源的 session 不在其中', () => {
    completion.acceptReport(CHILD, 'done', 'a')
    const views = lifecycleViewOf(sessions)
    assert.deepEqual(views.map((v) => v.sessionId), [CHILD])
    assert.equal(views[0]?.state, 'done')
    assert.equal(views[0]?.summary, 'done')
  })
})

describe('完成通知綁定於採納（handoff-completion）', () => {
  it('採納時通知一次（帶交接標題與摘要）；同一份檔再讀一次不再通知；拒絕與不存在不通知', () => {
    completion.acceptReport(CHILD, 'done', 'same')
    completion.acceptReport(CHILD, 'done', 'same')
    completion.acceptReport(PLAIN, 'x', 'p')
    completion.acceptReport('d0d0d0d0-0000-4000-8000-000000000000', 'x', 'g')
    assert.deepEqual(reported, [{ sessionId: CHILD, title: 'T', summary: 'done' }])
  })

  it('等待狀態推進（落定、重新開始）不通知 —— 通知綁定於採納，不綁定於「目前是已完成」', () => {
    completion.track(CHILD)
    completion.acceptReport(CHILD, 'done', 'a')
    tick('ready')
    tick('busy')
    tick('ready')
    assert.equal(reported.length, 1)
  })
})

describe('a session opened from a teammate\'s handoff (teammate-handoff-return D10)', () => {
  const LINKED = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
  function linked(answer: { ok: true; title: string } | { ok: false }) {
    const queued: { sessionId: string; handoffId: string; text: string }[] = []
    const notified: { sessionId: string; title: string; summary: string; sheet?: boolean }[] = []
    sessions.addProvisional({ id: LINKED, folderId: 'f2', spawnTarget: 'claude', teammateHandoff: { handoffId: 'h_9' } })
    const c = new HandoffCompletion({
      sessions,
      subscribe: () => () => {},
      onReported: (sessionId, title, summary, options) => notified.push({ sessionId, title, summary, ...(options ? { sheet: options.sheet } : {}) }),
      teammateReport: (sessionId, handoffId, text) => {
        queued.push({ sessionId, handoffId, text })
        return answer
      },
    })
    return { c, queued, notified }
  }

  it('queues done with the text, notifies without a sheet, sets no lifecycle', () => {
    const { c, queued, notified } = linked({ ok: true, title: 'Fix billing export' })
    assert.equal(c.acceptReport(LINKED, 'Exported', 'id-1'), 'accepted')
    assert.deepEqual(queued, [{ sessionId: LINKED, handoffId: 'h_9', text: 'Exported' }])
    assert.deepEqual(notified, [{ sessionId: LINKED, title: 'Fix billing export', summary: 'Exported', sheet: false }])
    assert.equal(completionOf(LINKED), undefined)
    assert.equal(c.acceptReport(LINKED, 'Exported', 'id-1'), 'duplicate')
    assert.equal(queued.length, 1)
  })

  it('a lone surrogate becomes U+FFFD, at the same length', () => {
    const { c, queued } = linked({ ok: true, title: 'T' })
    c.acceptReport(LINKED, 'ok \ud800 end', 'id-2')
    assert.equal(queued[0].text, 'ok \ufffd end')
  })

  it('reporting stopped: teammate-stopped, nothing notified', () => {
    const { c, notified } = linked({ ok: false })
    assert.equal(c.acceptReport(LINKED, 'R', 'id-3'), 'teammate-stopped')
    assert.equal(notified.length, 0)
  })
})

