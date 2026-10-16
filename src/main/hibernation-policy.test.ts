import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  type EligibilityInput,
  type ProcReader,
  type ShellFacts,
  busyReason,
  fileIdentity,
  isEligible,
  readShellFacts,
  tickPeriodMs,
} from './hibernation-policy'
import type { WaitState } from './agent-events'

const HOUR = 60 * 60 * 1000

/** An input that qualifies; each test changes one thing. */
function idle(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    displayed: false,
    now: 10 * HOUR,
    lastActivity: 0,
    thresholdMs: HOUR,
    target: 'shell',
    wait: 'unknown',
    unconfirmedSubmission: false,
    shell: 'idle',
    ...overrides,
  }
}

describe('isEligible (session-hibernation design D4)', () => {
  it('an idle shell past the threshold qualifies', () => {
    assert.equal(isEligible(idle()), true)
  })

  it('the displayed session never qualifies', () => {
    assert.equal(isEligible(idle({ displayed: true })), false)
  })

  it('activity inside the threshold keeps it', () => {
    assert.equal(isEligible(idle({ lastActivity: 9.5 * HOUR })), false)
    assert.equal(isEligible(idle({ lastActivity: 9 * HOUR })), true, 'exactly the threshold qualifies')
  })

  it('a threshold of 0 is off', () => {
    assert.equal(isEligible(idle({ thresholdMs: 0 })), false)
  })

  it('a shell qualifies only when /proc shows it idle', () => {
    assert.equal(isEligible(idle({ shell: 'busy' })), false)
    assert.equal(isEligible(idle({ shell: 'unknown' })), false, 'fails closed')
  })

  it('claude qualifies only while waiting for the next message', () => {
    const claude = (wait: EligibilityInput['wait']): EligibilityInput => idle({ target: 'claude', shell: 'unknown', wait })
    assert.equal(isEligible(claude('ready')), true)
    assert.equal(isEligible(claude('busy')), false)
    assert.equal(isEligible(claude('awaiting-choice')), false)
    assert.equal(isEligible(claude('unknown')), false, 'fails closed')
  })

  it('claude holding an unconfirmed filled-in prompt does not qualify', () => {
    assert.equal(isEligible(idle({ target: 'claude', wait: 'ready', unconfirmedSubmission: true })), false)
  })
})

describe('busyReason (remote-hibernate-close design D2)', () => {
  const agent = (wait: WaitState, unconfirmedSubmission = false) =>
    busyReason({ target: 'claude', wait, unconfirmedSubmission, shell: 'unknown' })
  const shell = (facts: ShellFacts) => busyReason({ target: 'shell', wait: 'unknown', unconfirmedSubmission: false, shell: facts })

  it('names why an agent is not idle', () => {
    assert.equal(agent('busy'), 'working')
    assert.equal(agent('awaiting-choice'), 'choice')
    assert.equal(agent('unknown'), 'unknown')
    assert.equal(agent('ready', true), 'unsent')
  })

  it('an agent waiting for its next message is idle, whatever its shell facts say', () => {
    assert.equal(agent('ready'), null)
  })

  it('names why a shell is not idle', () => {
    assert.equal(shell('busy'), 'job')
    assert.equal(shell('unknown'), 'unknown')
  })

  it('an idle shell is idle, whatever its wait state says', () => {
    assert.equal(shell('idle'), null)
  })
})

describe('tickPeriodMs', () => {
  it('is a quarter of the threshold, between 1 s and 60 s', () => {
    assert.equal(tickPeriodMs(24 * 60 * 60), 60_000)
    assert.equal(tickPeriodMs(120), 30_000)
    assert.equal(tickPeriodMs(2), 1_000)
    assert.equal(tickPeriodMs(0), 60_000)
  })
})

describe('readShellFacts with a fake /proc', () => {
  const identity = { dev: 1, ino: 42 }
  const proc = (exe: { dev: number; ino: number } | Error, children: string | Error): ProcReader => ({
    stat: () => {
      if (exe instanceof Error) throw exe
      return exe
    },
    readFile: () => {
      if (children instanceof Error) throw children
      return children
    },
  })

  it('unchanged binary and no children is idle', () => {
    assert.equal(readShellFacts(7, identity, proc(identity, '\n'), 'linux'), 'idle')
  })
  it('children is busy', () => {
    assert.equal(readShellFacts(7, identity, proc(identity, '123 '), 'linux'), 'busy')
  })
  it('a different binary is busy (the shell replaced itself)', () => {
    assert.equal(readShellFacts(7, identity, proc({ dev: 1, ino: 43 }, ''), 'linux'), 'busy')
  })
  it('a read failure is unknown', () => {
    assert.equal(readShellFacts(7, identity, proc(new Error('EACCES'), ''), 'linux'), 'unknown')
    assert.equal(readShellFacts(7, identity, proc(identity, new Error('ENOENT')), 'linux'), 'unknown')
  })
  it('no identity, or not Linux, is unknown', () => {
    assert.equal(readShellFacts(7, null, proc(identity, ''), 'linux'), 'unknown')
    assert.equal(readShellFacts(7, identity, proc(identity, ''), 'darwin'), 'unknown')
  })
})

/**
 * Against a real process. The shell reads its commands from a pipe; what `/proc` shows about its
 * children and its binary does not depend on that.
 */
describe('readShellFacts against a real shell', { skip: process.platform !== 'linux' }, () => {
  let child: ChildProcessWithoutNullStreams | null = null
  let dir: string | null = null

  afterEach(() => {
    child?.kill('SIGKILL')
    child = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  const settle = async (pid: number, expected: string, identity: ReturnType<typeof fileIdentity>): Promise<string> => {
    const deadline = Date.now() + 5000
    let last = readShellFacts(pid, identity)
    while (last !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      last = readShellFacts(pid, identity)
    }
    return last
  }

  function start(shell: string): { pid: number; send: (line: string) => void } {
    child = spawn(shell, [], { stdio: 'pipe' })
    const proc = child
    return { pid: proc.pid as number, send: (line) => proc.stdin.write(`${line}\n`) }
  }

  it('idle with nothing running, busy with a foreground or background job', async () => {
    const identity = fileIdentity('/bin/sh')
    const shell = start('/bin/sh')
    assert.equal(await settle(shell.pid, 'idle', identity), 'idle')

    shell.send('sleep 5 &')
    assert.equal(await settle(shell.pid, 'busy', identity), 'busy', 'a background job is a child')
  })

  it('busy after the shell replaced itself', async () => {
    const identity = fileIdentity('/bin/sh')
    const shell = start('/bin/sh')
    assert.equal(await settle(shell.pid, 'idle', identity), 'idle')
    shell.send('exec sleep 5')
    assert.equal(await settle(shell.pid, 'busy', identity), 'busy')
  })

  it('still the same shell after its binary was replaced on disk', async () => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'spek-hibernate-'))
    const copy = path.join(dir, 'sh')
    fs.copyFileSync(fs.realpathSync('/bin/sh'), copy)
    fs.chmodSync(copy, 0o755)
    const identity = fileIdentity(copy)
    const shell = start(copy)
    assert.equal(await settle(shell.pid, 'idle', identity), 'idle')

    // An upgrade: a new file renamed over the old path. `/proc/<pid>/exe` now reads "… (deleted)".
    const next = path.join(dir, 'sh.new')
    fs.copyFileSync(fs.realpathSync('/bin/sh'), next)
    fs.renameSync(next, copy)
    assert.match(fs.readlinkSync(`/proc/${shell.pid}/exe`), /\(deleted\)$/)
    assert.equal(readShellFacts(shell.pid, identity), 'idle')
  })
})
