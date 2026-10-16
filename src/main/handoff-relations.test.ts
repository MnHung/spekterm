import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { configureHandoff, relationsFile, resetHandoffState } from './handoff-outbox'
import { refreshRelations, relationsOf, resetRelationsState, type RelationsWorld } from './handoff-relations'
import type { PersistedSession } from './session-store'

const P = '11111111-1111-4111-8111-111111111111'
const C1 = '22222222-2222-4222-8222-222222222222'
const C2 = '33333333-3333-4333-8333-333333333333'
const G = '44444444-4444-4444-8444-444444444444'

function session(id: string, folderId: string | null, extra: Partial<PersistedSession> = {}): PersistedSession {
  return { id, folderId, spawnTarget: 'claude', ordinal: 0, peerName: `n-${id.slice(0, 4)}`, ...extra }
}
const child = (id: string, folderId: string, parentId = P): PersistedSession =>
  session(id, folderId, { lineage: { parentId, origin: { kind: 'folder', folderId: 'fa', folderName: 'alpha' }, parentTitle: 'P title' } })

function world(sessions: PersistedSession[], running: string[] = [], extra: Partial<RelationsWorld> = {}): RelationsWorld {
  return {
    view: sessions.map((s) => ({ session: s, provisional: false })),
    folders: [{ id: 'fa', name: 'alpha' }, { id: 'fb', name: 'beta' }],
    running: new Set(running),
    ...extra,
  }
}

describe('relationsOf', () => {
  it('子 session 查得到母 session 的名字與執行狀態', () => {
    const r = relationsOf(C1, world([session(P, 'fa', { title: 'P title' }), child(C1, 'fb')], [P, C1]))
    assert.deepEqual(r?.parent, { name: 'n-1111', repo: 'alpha', title: 'P title', running: true })
  })

  it('母 session 查得到它的子 session（跨 folder）', () => {
    const r = relationsOf(P, world([session(P, 'fa'), child(C1, 'fb')], [P, C1]))
    assert.deepEqual(r?.children, [{ name: 'n-2222', repo: 'beta', running: true }])
  })

  for (const [label, sessions, folders] of [
    ['母 session 已關閉', [child(C1, 'fb')], undefined],
    ['母 session 所屬 folder 被移除', [session(P, 'fgone'), child(C1, 'fb')], undefined],
  ] as const) {
    it(`${label} ⇒ closed，repo 與標籤取自快照`, () => {
      const r = relationsOf(C1, world([...sessions], [C1], folders))
      assert.deepEqual(r?.parent, { closed: true, repo: 'alpha', title: 'P title' })
    })
  }

  it('快照歸屬為未知時沒有 repo（不是 global）', () => {
    const orphan = session(C1, 'fb', { lineage: { parentId: P, origin: { kind: 'unknown' } } })
    assert.deepEqual(relationsOf(C1, world([orphan], [C1]))?.parent, { closed: true })
  })

  it('子 session 的標籤是交接的標題，不是 pty 宣告的固定名字（handoff-brief）', () => {
    const withBrief = session(C1, 'fb', {
      title: '✳ beta-2222',
      lineage: {
        parentId: P,
        origin: { kind: 'folder', folderId: 'fa', folderName: 'alpha' },
        brief: { title: 'Fix login', receivedAt: 0 },
      },
    })
    const r = relationsOf(P, world([session(P, 'fa'), withBrief], [P, C1]))
    assert.equal(r?.children[0]?.title, 'Fix login')
  })

  it('子／兄弟附帶生命週期：已完成者附摘要、未完成者只有狀態、休眠者為 idle；無路徑欄位（handoff-completion）', () => {
    const lifecycle = new Map([
      [C1, { state: 'done' as const, summary: 'fixed login' }],
      [C2, { state: 'idle' as const }],
    ])
    const r = relationsOf(P, world([session(P, 'fa'), child(C1, 'fb'), child(C2, 'fb')], [P, C1], { lifecycle }))
    assert.deepEqual(
      r?.children.map((c) => ({ state: c.state, summary: c.summary, running: c.running })),
      [
        { state: 'done', summary: 'fixed login', running: true },
        { state: 'idle', summary: undefined, running: false },
      ],
    )
    const text = JSON.stringify(r)
    assert.ok(!text.includes('/') && !text.includes(C1), text)
    // 兄弟也看得到彼此的狀態。
    const sib = relationsOf(C2, world([session(P, 'fa'), child(C1, 'fb'), child(C2, 'fb')], [P, C1], { lifecycle }))
    assert.equal(sib?.siblings[0]?.state, 'done')
  })

  it('休眠的母 session 存在但 running 為假', () => {
    const r = relationsOf(C1, world([session(P, 'fa'), child(C1, 'fb')], [C1]))
    assert.equal((r?.parent as { running: boolean }).running, false)
  })

  it('全域的母 session 以 global 為 repo', () => {
    const r = relationsOf(C1, world([session(G, null), child(C1, 'fb', G)], [G, C1]))
    assert.equal((r?.parent as { repo: string }).repo, 'global')
  })

  it('兄弟不含自己；關閉的兄弟不列', () => {
    const all = [session(P, 'fa'), child(C1, 'fb'), child(C2, 'fa')]
    assert.deepEqual(relationsOf(C1, world(all, [P, C1, C2]))?.siblings.map((s) => s.name), ['n-3333'])
    assert.deepEqual(relationsOf(C1, world([session(P, 'fa'), child(C1, 'fb')], [P, C1]))?.siblings, [])
  })

  it('母 session 關閉之後兄弟仍互列', () => {
    const r = relationsOf(C1, world([child(C1, 'fb'), child(C2, 'fa')], [C1, C2]))
    assert.deepEqual(r?.siblings.map((s) => s.name), ['n-3333'])
  })

  it('暫定而 pty 已死的子 session 不列（renderer 在持久化之前重新載入）', () => {
    const w = world([session(P, 'fa')], [P])
    const withProvisional = { ...w, view: [...w.view, { session: child(C1, 'fb'), provisional: true }] }
    assert.deepEqual(relationsOf(P, withProvisional)?.children, [])
    assert.equal(relationsOf(P, { ...withProvisional, running: new Set([P, C1]) })?.children.length, 1)
  })

  it('輸出沒有路徑欄位，也沒有 spekterm 的識別碼', () => {
    const text = JSON.stringify(relationsOf(C1, world([session(P, 'fa'), child(C1, 'fb'), child(C2, 'fa')], [P, C1, C2])))
    for (const id of [P, C1, C2]) assert.ok(!text.includes(id), id)
    assert.ok(!/"(path|cwd|dir)"/.test(text))
  })
})

describe('the descendant tree (agent-session-control)', () => {
  const G2 = '55555555-5555-4555-8555-555555555555'

  it('a grandchild hangs under its parent, with the same fields as a child', () => {
    const r = relationsOf(P, world([session(P, 'fa'), child(C1, 'fb'), child(G, 'fb', C1)], [P, C1, G]))
    assert.deepEqual(r?.children, [
      { name: 'n-2222', repo: 'beta', running: true, children: [{ name: 'n-4444', repo: 'beta', running: true }] },
    ])
  })

  it('a descendant whose parent closed hangs under its nearest existing ancestor, marked', () => {
    // C1 is gone; G recorded the chain at ingestion.
    const g = session(G, 'fb', { lineage: { parentId: C1, origin: { kind: 'unknown' }, ancestors: [P] } })
    const r = relationsOf(P, world([session(P, 'fa'), g], [P, G]))
    assert.deepEqual(r?.children, [{ name: 'n-4444', repo: 'beta', running: true, parentGone: true }])
  })

  it('a parent whose folder left the workspace is not listed, and the chain still runs through its record', () => {
    const r = relationsOf(P, world([session(P, 'fa'), child(C1, 'fgone'), child(G, 'fb', C1)], [P, C1, G]))
    assert.deepEqual(r?.children, [{ name: 'n-4444', repo: 'beta', running: true, parentGone: true }])
  })

  it('a descendant whose folder left the workspace is not listed', () => {
    const r = relationsOf(P, world([session(P, 'fa'), child(C1, 'fb'), child(G, 'fgone', C1)], [P, C1, G]))
    assert.deepEqual(r?.children, [{ name: 'n-2222', repo: 'beta', running: true }])
  })

  it("siblings carry no descendants, and a sibling's child is not in the tree", () => {
    const r = relationsOf(C1, world([session(P, 'fa'), child(C1, 'fb'), child(C2, 'fb'), child(G, 'fb', C2)], [P, C1, C2, G]))
    assert.deepEqual(r?.siblings, [{ name: 'n-3333', repo: 'beta', running: true }])
    assert.deepEqual(r?.children, [])
    assert.ok(!JSON.stringify(r).includes('n-4444'))
  })

  it('the tree holds no path field and no spekterm id at any depth', () => {
    const r = relationsOf(P, world([session(P, 'fa'), child(C1, 'fb'), child(G, 'fb', C1), child(G2, 'fb', G)], [P, C1, G, G2]))
    const text = JSON.stringify(r)
    for (const id of [P, C1, G, G2]) assert.ok(!text.includes(id), id)
    assert.ok(!/"(path|cwd|dir|parentId|ancestors)"/.test(text))
    assert.equal(r?.children[0]?.children?.[0]?.children?.[0]?.name, 'n-5555')
  })
})

describe('refreshRelations', () => {
  let base: string
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(tmpdir(), 'relations-'))
    resetHandoffState()
    resetRelationsState()
    configureHandoff(base)
  })
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

  it('新的子 session 一出現（尚未被持久化），母 session 的檔就含它', () => {
    const w = world([session(P, 'fa')], [P])
    refreshRelations({ ...w, agents: [P] })
    assert.deepEqual(JSON.parse(fs.readFileSync(relationsFile(P), 'utf8')).children, [])

    const grown = { ...w, view: [...w.view, { session: child(C1, 'fb'), provisional: true }], running: new Set([P, C1]) }
    refreshRelations({ ...grown, agents: [P, C1] })
    assert.equal(JSON.parse(fs.readFileSync(relationsFile(P), 'utf8')).children[0].name, 'n-2222')
  })

  it('不再執行的 session 其檔被刪除', () => {
    const w = world([session(P, 'fa'), child(C1, 'fb')], [P, C1])
    refreshRelations({ ...w, agents: [P, C1] })
    refreshRelations({ ...w, running: new Set([P]), agents: [P] })
    assert.ok(fs.existsSync(relationsFile(P)))
    assert.ok(!fs.existsSync(relationsFile(C1)))
  })
})
