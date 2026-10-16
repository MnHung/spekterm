/**
 * When something last typed into each session (`remote-protocol`, D3 of `remote-prompts-attachments-rename`).
 *
 * A device may answer an open permission prompt only while nothing was typed into the session since the
 * prompt's tool call started. A prompt answered, dismissed or half-answered on the desktop reports nothing
 * until its tool ends, or nothing at all, but it always took a key. Every pty write goes through
 * `TerminalService.write`, which reports here.
 *
 * **A keystroke is any write except two kinds:**
 * - a device answer's own keys (`origin: 'answer'`): the answer must not make its own prompt unanswerable;
 * - the terminal's own reports: focus in/out, which the agent turns on (`ESC [ ? 1004 h`, measured), and
 *   mouse reports, in case an agent turns them on. A click or a window switch is not someone answering.
 *
 * The time is wall-clock ms, the clock of the event files' names (`agent-events.ts` `fileTimeOf`).
 */

const lastKeystroke = new Map<string, number>()
const listeners = new Set<(sessionId: string) => void>()

export type WriteOrigin = 'answer'

// eslint-disable-next-line no-control-regex
const REPORT = /^(?:\x1b\[[IO]|\x1b\[M[\s\S]{3}|\x1b\[<\d+;\d+;\d+[Mm])+$/

/** Whether `data` is only the terminal's own focus or mouse reports. */
export function isTerminalReport(data: string): boolean {
  return REPORT.test(data)
}

/** Called by `TerminalService.write` for every write. */
export function noteWrite(sessionId: string, data: string, origin?: WriteOrigin, now: number = Date.now()): void {
  if (origin === 'answer' || data === '' || isTerminalReport(data)) return
  lastKeystroke.set(sessionId, now)
  for (const listener of listeners) {
    try {
      listener(sessionId)
    } catch (error) {
      console.error(`[pty-input] listener failed: ${String(error)}`)
    }
  }
}

/** The wall-clock ms of the session's last keystroke, or `null`. */
export function lastKeystrokeAt(sessionId: string): number | null {
  return lastKeystroke.get(sessionId) ?? null
}

/** Sees every keystroke, after it is recorded. */
export function onKeystroke(listener: (sessionId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function forgetInput(sessionId: string): void {
  lastKeystroke.delete(sessionId)
}
