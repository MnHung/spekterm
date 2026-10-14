import type { TFunction } from 'i18next'
import { useEffect, useState } from 'react'

export type RemoteState = Awaited<ReturnType<typeof window.workspace.remote.state>>

/**
 * The remote access state as the main process projects it (no credential, hash or key), kept current.
 * Subscribes before fetching, so a change between the two is not lost.
 */
export function useRemoteState(initial: RemoteState | null = null): RemoteState | null {
  const [state, setState] = useState<RemoteState | null>(initial)
  useEffect(() => {
    let alive = true
    const off = window.workspace.remote.onChanged((next) => {
      if (alive) setState(next)
    })
    void window.workspace.remote.state().then((next) => {
      if (alive) setState((current) => current ?? next)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}

/** The line Settings and the dialog show for the listener (`remote-access`'s listen failure). */
export function listenLine(state: RemoteState, t: TFunction): string {
  const listen = state.listen
  if (listen.status === 'listening') return t('remote.state.listening', { port: listen.port })
  if (listen.status === 'error') {
    if (listen.error === 'in-use') return t('remote.state.inUse', { port: listen.port })
    if (listen.error === 'denied') return t('remote.state.denied', { port: listen.port })
    return t('remote.state.other', { port: listen.port, message: listen.message })
  }
  return t('remote.state.off')
}
