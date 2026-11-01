/**
 * What happens to the persisted sessions when a renderer goes (window closed, reloaded). **Flush first, then drop
 * the provisional entries** (`restore-running-sessions` D1): a session created in the last moments before this
 * has its main-owned fields (`running`, `lineage`, `peerName`) only in its provisional entry, and the flush's
 * `replace()` reads them from there. Dropped first, the session came back without them — dormant, and no longer
 * nested under its parent.
 *
 * Kept free of `electron` so the order is unit tested (`ipc/terminal.ts` cannot be imported under node:test).
 */
export function releaseSessions(sessions: { dropProvisional(): void }, flush: () => void): void {
  flush()
  // 尚未被 renderer 送來持久化的 session 永遠不會被送來了（新頁面不知道它們）。
  sessions.dropProvisional()
}
