import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import type { Attention } from '@shared/wait/attention'

/**
 * Every running agent session's attention state on screen (`session-wait-indicator`). **The main process owns it** —
 * the seen mark, the wait state and who is looking all live there; this holds the projection
 * (`window.workspace.wait.list` / `onChanged`) and nothing that could set it.
 */

interface WaitApi {
  /** `undefined` for a session that is not a running agent session. */
  attentionOf(sessionId: string): Attention | undefined
}

const WaitContext = createContext<WaitApi | null>(null)

export function useAttention(): WaitApi {
  const api = useContext(WaitContext)
  if (!api) throw new Error('useAttention must be used within WaitProvider')
  return api
}

export function WaitProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [entries, setEntries] = useState<ReadonlyMap<string, Attention>>(new Map())

  // One subscription for the app's life, made before the first read (`docs/lessons/handoff.md` §6): a projection
  // pushed between the two cannot be lost.
  useEffect(() => {
    let alive = true
    const apply = (views: { sessionId: string; attention: Attention }[]): void => {
      if (alive) setEntries(new Map(views.map((view) => [view.sessionId, view.attention])))
    }
    const unsubscribe = window.workspace.wait.onChanged(apply)
    void window.workspace.wait.list().then(apply)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const attentionOf = useCallback((sessionId: string) => entries.get(sessionId), [entries])
  const api = useMemo(() => ({ attentionOf }), [attentionOf])
  return <WaitContext.Provider value={api}>{children}</WaitContext.Provider>
}
