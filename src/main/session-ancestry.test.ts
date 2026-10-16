import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { lineageSourceOf } from './handoff-service'
import { configureTicketLineage, handoffTickets, ticketResolutionFor } from './handoff-ticket'
import { parseHandoffSource, type Intake } from './intake-schema'
import { IntakeStore } from './intake-store'
import { createSession } from './session-create'
import { parseLineage, SessionStore } from './session-store'

/**
 * The chain of ancestors (`session-lineage`, "A session records its whole chain of ancestors";
 * `agent-session-control` design D4): taken at ingestion, copied at creation, read back field by field.
 */

const GRAND = 'a0000000-0000-4000-8000-000000000001'
const PARENT = 'a0000000-0000-4000-8000-000000000002'

function intakeFrom(sessionId: string, ancestors?: string[]): Intake {
  return {
    id: 'h1',
    verified: {
      adapter: 'handoff',
      originKind: 'handoff',
      originId: sessionId,
      firstPartyBody: true,
      source: lineageSourceOf(sessionId, { folderId: 'f1', label: 'alpha', ...(ancestors ? { ancestors } : {}) }),
    },
    authored: { title: 'T', body: 'B', actor: 'agent', originLabel: 'alpha' },
    receivedAt: 1_790_000_000_000,
  }
}

let dir: string
let sessions: SessionStore
let intake: IntakeStore

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), 'session-ancestry-'))
  sessions = new SessionStore(path.join(dir, 'sessions.json'), path.join(dir, 'sessions'))
  sessions.load()
  intake = new IntakeStore(path.join(dir, 'intake.json'))
  intake.load()
  configureTicketLineage(({ adapter, id }) => ticketResolutionFor(intake.get(adapter, id)))
})

afterEach(() => {
  configureTicketLineage(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

async function createFor(id: string): Promise<string> {
  const ticket = handoffTickets.issue({ adapter: 'handoff', id, folderId: 'f2' })
  const result = await createSession({
    sessions,
    folderId: 'f2',
    target: 'claude',
    railLabel: 'beta',
    ticket,
    spawn: async (sessionId) => ({ sessionId }),
  })
  return result.sessionId
}

const lineageOf = (sessionId: string) => sessions.view().find((v) => v.session.id === sessionId)?.session.lineage

describe('the chain is taken at ingestion', () => {
  it('a session created later records the chain the source had when its handoff arrived', async () => {
    // The parent's record is not in this store at all: creation must not need it.
    intake.add(intakeFrom(PARENT, [GRAND]))
    const child = await createFor('h1')
    assert.equal(lineageOf(child)?.parentId, PARENT)
    assert.deepEqual(lineageOf(child)?.ancestors, [GRAND])
  })

  it('a source with no ancestors gives a lineage without the field', async () => {
    intake.add(intakeFrom(PARENT))
    const child = await createFor('h1')
    assert.equal(lineageOf(child)?.ancestors, undefined)
  })

  it('the chain survives the intake record being read back from disk', () => {
    const source = parseHandoffSource(JSON.parse(JSON.stringify(intakeFrom(PARENT, [GRAND]).verified.source)))
    assert.deepEqual(source?.ancestors, [GRAND])
    assert.equal(parseHandoffSource({ ...intakeFrom(PARENT).verified.source, ancestors: ['nope'] })?.ancestors, undefined)
  })

  it('only ids leave the source', () => {
    assert.deepEqual(lineageSourceOf(PARENT, { folderId: null, label: 'Global', ancestors: [GRAND, '/home/me'] })?.ancestors, [GRAND])
  })
})

describe('the chain is read back field by field', () => {
  it('an invalid chain drops only that field', () => {
    const parsed = parseLineage({ parentId: PARENT, origin: { kind: 'global' }, ancestors: [GRAND, 42] })
    assert.ok(parsed)
    assert.equal(parsed.parentId, PARENT)
    assert.equal(parsed.ancestors, undefined)
    assert.deepEqual(parseLineage({ parentId: PARENT, origin: { kind: 'global' }, ancestors: [GRAND] })?.ancestors, [GRAND])
  })

  it('the renderer cannot write the chain', async () => {
    intake.add(intakeFrom(PARENT, [GRAND]))
    const child = await createFor('h1')
    const forged = { lineage: { parentId: GRAND, origin: { kind: 'global' }, ancestors: [] } }
    sessions.replace([{ id: child, folderId: 'f2', spawnTarget: 'claude', ordinal: 1, ...forged } as never])
    assert.equal(lineageOf(child)?.parentId, PARENT)
    assert.deepEqual(lineageOf(child)?.ancestors, [GRAND])
    const reloaded = new SessionStore(path.join(dir, 'sessions.json'), path.join(dir, 'sessions'))
    reloaded.load()
    assert.deepEqual(reloaded.view().find((v) => v.session.id === child)?.session.lineage?.ancestors, [GRAND])
  })
})
