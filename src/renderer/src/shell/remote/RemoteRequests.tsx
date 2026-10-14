import { useEffect, useRef } from 'react'

import { runAccept } from '../intake/accept-flow'
import { useSessions } from '../terminal/sessions'

/**
 * Carries out a paired device's session actions (`remote-protocol`, design D4 of `mobile-remote-bridge`).
 *
 * The renderer owns the session list, so the main process asks it (`workspace:remote:request`) and waits for
 * the outcome. Every action goes through the path the desktop's own controls use, **quietly**: nothing here
 * changes the rail selection, any item's focused session, or keyboard focus.
 *
 * **Resident** — a device acts while the user is doing something else. Subscribes once and keeps the changing
 * values in a ref (the `IntakeAutoAccept` pattern), so a re-render never drops a request in flight.
 */
export function RemoteRequests(): null {
  const sessions = useSessions()
  const latest = useRef(sessions)
  useEffect(() => {
    latest.current = sessions
  })

  useEffect(
    () =>
      window.workspace.remote.onRequest((requestId, action) => {
        const reply = (outcome: Parameters<typeof window.workspace.remote.reply>[1]): void =>
          window.workspace.remote.reply(requestId, outcome)
        void (async () => {
          const api = latest.current
          try {
            if (action.kind === 'create') {
              const outcome = await api.create(action.folderId, action.target, { quiet: true })
              if (outcome.status === 'created') reply({ ok: true, sessionId: outcome.sessionId })
              else reply({ ok: false, code: 'CREATE_FAILED', message: outcome.failure.message })
              return
            }
            if (action.kind === 'wake') {
              const session = api.all().find((candidate) => candidate.id === action.sessionId)
              if (!session || session.status === 'exited') {
                reply({ ok: false, code: 'NOT_FOUND', message: 'no dormant session with that id' })
                return
              }
              // The main process asks only when the session has no process; a `running` here can be a status
              // that has not caught up with a hibernation yet, so the wake path runs regardless.
              const outcome = await api.wake(session.id, { quiet: true })
              if (outcome.status === 'woken') reply({ ok: true, sessionId: session.id })
              else reply({ ok: false, code: 'CREATE_FAILED', message: outcome.message })
              return
            }
            const outcome = await runAccept(
              { intake: window.workspace.intake, sessions: api },
              { id: action.id, adapter: action.adapter },
              action.folderId,
              { quiet: true },
            )
            if (outcome.ok) reply({ ok: true, sessionId: outcome.sessionId })
            else if (outcome.reason === 'createFailed') reply({ ok: false, code: 'CREATE_FAILED', message: outcome.message })
            else if (outcome.reason === 'prefillUnavailable') {
              reply({ ok: false, code: 'CREATE_FAILED', message: 'agent events are off, so the prompt cannot be filled in' })
            } else reply({ ok: false, code: 'NOT_FOUND', message: outcome.reason === 'FOLDER_GONE' ? 'the folder is gone' : 'no such item' })
          } catch (error) {
            reply({ ok: false, code: 'CREATE_FAILED', message: String(error) })
          }
        })()
      }),
    [],
  )

  return null
}
