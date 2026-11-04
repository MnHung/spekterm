import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { configureTeammateTickets, TICKET_TTL_MS, TicketStore, ticketFor, ticketResolutionFor } from './handoff-ticket'
import type { IntakeRecord } from './intake-store'

const claim = { adapter: 'handoff', id: 'h1', folderId: 'f2' }

describe('交接的單次憑證', () => {
  it('相符時回傳綁定的 record', () => {
    const store = new TicketStore()
    const token = store.issue(claim)
    assert.deepEqual(store.consume(token, 'f2', 'claude'), claim)
  })

  it('同一張用兩次，第二次無效', () => {
    const store = new TicketStore()
    const token = store.issue(claim)
    store.consume(token, 'f2', 'claude')
    assert.equal(store.consume(token, 'f2', 'claude'), null)
  })

  it('folder 不符無效，且那張憑證就此作廢', () => {
    const store = new TicketStore()
    const token = store.issue(claim)
    assert.equal(store.consume(token, 'f9', 'claude'), null)
    assert.equal(store.consume(token, 'f2', 'claude'), null)
  })

  it('shell 目標無效', () => {
    const store = new TicketStore()
    assert.equal(store.consume(store.issue(claim), 'f2', 'shell'), null)
  })

  it('逾時無效', () => {
    let now = 0
    const store = new TicketStore(() => now)
    const token = store.issue(claim)
    now = TICKET_TTL_MS
    assert.equal(store.consume(token, 'f2', 'claude'), null)
  })

  it('不是字串或從未簽發的值無效', () => {
    const store = new TicketStore()
    assert.equal(store.consume(undefined, 'f2', 'claude'), null)
    assert.equal(store.consume('deadbeef', 'f2', 'claude'), null)
    assert.equal(store.consume({ id: 'h1' }, 'f2', 'claude'), null)
  })
})

describe('簽發的條件', () => {
  const source = { sessionId: 'c463620e-cfbf-40e4-9732-685d0ea94b89', origin: { kind: 'global' as const } }
  const record = (state: IntakeRecord['state'], withSource = true): IntakeRecord => ({
    adapter: 'handoff',
    id: 'h1',
    state,
    digest: 'd',
    content: {
      verified: { adapter: 'handoff', originKind: 'session', originId: 'x', ...(withSource ? { source } : {}) },
      authored: { title: 't', body: 'b', actor: 'a', originLabel: 'o' },
      receivedAt: 0,
    },
  })

  it('待處理且有來源才簽發', () => {
    assert.ok(ticketFor(record('pending'), 'f2', new TicketStore()))
  })
  it('已接受（含已了結）不簽發 —— 歷史上的交接不能再長出子 session', () => {
    assert.equal(ticketFor(record('accepted'), 'f2', new TicketStore()), undefined)
  })
  it('沒有來源不簽發', () => {
    assert.equal(ticketFor(record('pending', false), 'f2', new TicketStore()), undefined)
  })
})

describe('teammate handoffs (teammate-handoff-return D7)', () => {
  const teammate = (state: IntakeRecord['state'] = 'pending'): IntakeRecord => ({
    adapter: 'teammate',
    id: 'teammate:h.0123',
    state,
    digest: 'd',
    content: {
      verified: { adapter: 'teammate', originKind: 'teammate', originId: 'sam' },
      authored: { title: 't', body: 'b', actor: 'Sam', originLabel: 'Acme' },
      receivedAt: 0,
    },
  })

  it('issues a ticket only for a reportable pending teammate record', () => {
    let reportable = false
    configureTeammateTickets({ reportable: () => reportable, linked: () => {} })
    try {
      assert.equal(ticketFor(teammate(), 'f2', new TicketStore()), undefined)
      reportable = true
      assert.ok(ticketFor(teammate(), 'f2', new TicketStore()))
      assert.equal(ticketFor(teammate('accepted'), 'f2', new TicketStore()), undefined)
    } finally {
      configureTeammateTickets({ reportable: () => false, linked: () => {} })
    }
  })

  it('resolves to the server id, without a lineage', () => {
    assert.deepEqual(ticketResolutionFor(teammate()), { teammate: { handoffId: 'h_0123' } })
  })
})

