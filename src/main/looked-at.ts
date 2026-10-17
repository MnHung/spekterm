/**
 * Who is looking at a session (`session-wait-indicator`): the session a focused window displays, or one whose
 * conversation a paired device watches. The sources are injected so the focus condition is unit tested — under Xvfb a
 * probe may have no focused window at all.
 */
export interface LookingSources {
  /** The `webContents.id` of the focused window, or `null` when no window has focus. */
  focusedContentsId(): number | null
  displayedSessionOf(contentsId: number): string | null
  conversationWatched(sessionId: string): boolean
}

export interface LookedAt {
  /** The desktop user sees this session: it is displayed in the window that has focus. */
  displayedInFocus(sessionId: string): boolean
  /** The desktop user or a device's user sees this session. */
  isLookedAt(sessionId: string): boolean
  /** A window reported the session it displays (after the report was recorded). */
  displayedReported(contentsId: number, sessionId: string | null): void
  /** A window gained focus. */
  windowFocused(contentsId: number): void
  /** A device started or stopped a watch (`HibernationTracker.setRemoteWatched`'s key). */
  remoteWatched(watchKey: string, sessionId: string | null): void
}

/** `onLooked` is called for each moment a session becomes looked at; the caller clears its seen mark. */
export function createLookedAt(sources: LookingSources, onLooked: (sessionId: string) => void): LookedAt {
  const displayedInFocus = (sessionId: string): boolean => {
    const focused = sources.focusedContentsId()
    return focused !== null && sources.displayedSessionOf(focused) === sessionId
  }
  return {
    displayedInFocus,
    isLookedAt: (sessionId) => displayedInFocus(sessionId) || sources.conversationWatched(sessionId),
    displayedReported(contentsId, sessionId) {
      if (sessionId !== null && sources.focusedContentsId() === contentsId) onLooked(sessionId)
    },
    windowFocused(contentsId) {
      const sessionId = sources.displayedSessionOf(contentsId)
      if (sessionId !== null) onLooked(sessionId)
    },
    remoteWatched(watchKey, sessionId) {
      if (sessionId !== null && watchKey.endsWith(':conversation')) onLooked(sessionId)
    },
  }
}
