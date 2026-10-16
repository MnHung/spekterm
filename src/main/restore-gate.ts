/**
 * Per window: has its renderer restored its sessions yet (`agent-session-control`, design D9)?
 *
 * A session command asked of a window before its restore would find no listener or an empty session list, and
 * would fail for a session that exists. The gate opens when the main process **receives** the window's first
 * session-list sync (the renderer sends one only after its restore, even when nothing changed), and closes again
 * when the window reloads or goes. Electron-free: `ipc/terminal.ts` opens and closes it.
 */

const open = new Set<number>()
const waiters = new Map<number, Set<() => void>>()

export function openRestoreGate(contentsId: number): void {
  if (open.has(contentsId)) return
  open.add(contentsId)
  for (const wake of waiters.get(contentsId) ?? []) wake()
  waiters.delete(contentsId)
}

export function closeRestoreGate(contentsId: number): void {
  open.delete(contentsId)
}

/**
 * Resolves `true` once the window's gate is open, or `false` after `timeoutMs`. **Bounded**: a renderer that
 * crashed (`render-process-gone` fires neither `did-navigate` nor `destroyed`) must not hold commands forever.
 */
export function whenRestored(contentsId: number, timeoutMs: number): Promise<boolean> {
  if (open.has(contentsId)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const set = waiters.get(contentsId) ?? new Set<() => void>()
    waiters.set(contentsId, set)
    const wake = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      set.delete(wake)
      resolve(false)
    }, timeoutMs)
    set.add(wake)
  })
}

/** Tests only. */
export function resetRestoreGates(): void {
  open.clear()
  waiters.clear()
}
