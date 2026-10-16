import fs from 'node:fs'

import type { WaitState } from './agent-events'
import type { SpawnTarget } from './terminal'

/**
 * When a running session may be hibernated automatically (`session-hibernation`, design D4).
 *
 * **Pure, and failing closed**: every input that cannot establish idleness keeps the session
 * running. Ending a process the user was relying on cannot be undone; an extra process costs memory.
 */

/** What `/proc` says about a shell session's process. */
export type ShellFacts = 'idle' | 'busy' | 'unknown'

export interface EligibilityInput {
  /** The session is the one a renderer currently displays. */
  displayed: boolean
  now: number
  /** Last activity (display change, shell output, agent wait-state change), in ms. */
  lastActivity: number
  /** The threshold in ms. `0` or less = automatic hibernation is off. */
  thresholdMs: number
  target: SpawnTarget
  /** The agent's wait state (claude). Ignored for a shell. */
  wait: WaitState
  /** A filled-in prompt has been written and not yet confirmed as sent (claude). */
  unconfirmedSubmission: boolean
  /** The shell's process facts. Ignored for claude. */
  shell: ShellFacts
}

export function isEligible(input: EligibilityInput): boolean {
  if (input.thresholdMs <= 0) return false
  if (input.displayed) return false
  if (input.now - input.lastActivity < input.thresholdMs) return false
  return busyReason(input) === null
}

/**
 * Why a running session is not idle, or `null` when it is (`remote-hibernate-close`, design D2–D3).
 *
 * **The one definition of idle**, shared by automatic hibernation (`isEligible`) and a paired device's
 * hibernate or close (`remote-host.ts`), so a rule added for one cannot leave the other answering the old
 * question.
 */
export type BusyReason = 'working' | 'choice' | 'unsent' | 'unknown' | 'job'

export function busyReason(input: Pick<EligibilityInput, 'target' | 'wait' | 'unconfirmedSubmission' | 'shell'>): BusyReason | null {
  if (input.target === 'claude') {
    // Only `ready` is idle: `busy` is working, `awaiting-choice` would lose a pending tool call on resume,
    // and `unknown` cannot show idleness.
    if (input.wait === 'busy') return 'working'
    if (input.wait === 'awaiting-choice') return 'choice'
    if (input.wait === 'unknown') return 'unknown'
    return input.unconfirmedSubmission ? 'unsent' : null
  }
  // `busy` covers a job and a shell that replaced itself (`readShellFacts`).
  if (input.shell === 'busy') return 'job'
  return input.shell === 'unknown' ? 'unknown' : null
}

/** How often the policy is evaluated: a quarter of the threshold, between 1 s and 60 s. */
export function tickPeriodMs(thresholdSeconds: number): number {
  if (thresholdSeconds <= 0) return 60_000
  return Math.min(60_000, Math.max(1_000, Math.floor((thresholdSeconds * 1000) / 4)))
}

/** A file's identity — device and inode — which survives the file being replaced on disk. */
export interface FileIdentity {
  dev: number
  ino: number
}

/**
 * The identity of the binary a shell path resolves to, recorded when the shell is spawned.
 *
 * **Not read from `/proc/<pid>/exe` at spawn**: node-pty returns the pid right after `fork`, when the
 * link may still name Electron's own binary. `null` when it cannot be resolved — the session then
 * never qualifies.
 */
export function fileIdentity(file: string, fsImpl: Pick<typeof fs, 'realpathSync' | 'statSync'> = fs): FileIdentity | null {
  try {
    const stat = fsImpl.statSync(fsImpl.realpathSync(file))
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

export interface ProcReader {
  /** `stat()` of a path (it follows symlinks — `/proc/<pid>/exe` included, even to a deleted file). */
  stat(file: string): { dev: number; ino: number }
  readFile(file: string): string
}

const realProc: ProcReader = {
  stat: (file) => fs.statSync(file),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
}

/**
 * Whether a shell session's process is idle: it is **still the shell it was spawned as**, and it has
 * **no child processes**.
 *
 * - Any job, foreground or background, is a child of the shell, so the children clause covers both
 *   (`tpgid` would miss a background job and adds nothing, so it is not read).
 * - After `exec vim` the pid is the editor — foreground and childless — so identity is checked. By
 *   file identity, not by the link's text: an upgraded shell binary makes the link read
 *   `… (deleted)`, while `stat` still follows it to the old inode, which still matches.
 * - Transient hook processes (a `preexec` hook) only make one evaluation fail; the next one retries.
 * - Linux only. Anything that cannot be read is `unknown`.
 */
export function readShellFacts(
  pid: number,
  identity: FileIdentity | null,
  proc: ProcReader = realProc,
  platform: NodeJS.Platform = process.platform,
): ShellFacts {
  if (platform !== 'linux' || identity === null) return 'unknown'
  try {
    const exe = proc.stat(`/proc/${pid}/exe`)
    if (exe.dev !== identity.dev || exe.ino !== identity.ino) return 'busy'
    const children = proc.readFile(`/proc/${pid}/task/${pid}/children`).trim()
    return children === '' ? 'idle' : 'busy'
  } catch {
    return 'unknown'
  }
}
