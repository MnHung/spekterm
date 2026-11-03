import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatDateTime, formatTime } from '@shared/i18n/locale'
import { BUTTON_CLASS, FieldError, HINT_CLASS, INPUT_CLASS, LABEL_CLASS } from '../fields'

type TeamView = Awaited<ReturnType<typeof window.workspace.team.get>>
type InspectView = Awaited<ReturnType<typeof window.workspace.team.inspect>>

const SECTION_CLASS = 'mt-4 border-t border-hairline pt-3'

/**
 * Codes from the main process mapped to dictionary keys **by table**, so a code the renderer does not know shows the
 * generic text instead of a key, and the dictionary's key type checks each entry.
 */
const STOP_KEYS = {
  REPLACED: 'team.stop.REPLACED',
  UNSUPPORTED_VERSION: 'team.stop.UNSUPPORTED_VERSION',
  UNSUPPORTED_VERSION_spekterm: 'team.stop.UNSUPPORTED_VERSION_spekterm',
  UNSUPPORTED_VERSION_server: 'team.stop.UNSUPPORTED_VERSION_server',
  FAULT: 'team.stop.FAULT',
  PIN_MISMATCH: 'team.stop.PIN_MISMATCH',
  CREDENTIAL_UNAVAILABLE: 'team.stop.CREDENTIAL_UNAVAILABLE',
  REVOKED: 'team.stop.REVOKED',
} as const
const RETRY_KEYS = {
  NETWORK: 'team.retry.NETWORK',
  TLS: 'team.retry.TLS',
  TIMEOUT: 'team.retry.TIMEOUT',
  SERVER_CLOSED: 'team.retry.SERVER_CLOSED',
  SERVER_ERROR: 'team.retry.SERVER_ERROR',
} as const
const JOIN_ERROR_KEYS = {
  INVALID_LINK: 'team.joinError.INVALID_LINK',
  INVITE_UNKNOWN: 'team.joinError.INVITE_UNKNOWN',
  INVITE_EXPIRED: 'team.joinError.INVITE_EXPIRED',
  INVITE_USED: 'team.joinError.INVITE_USED',
  HANDLE_TAKEN: 'team.joinError.HANDLE_TAKEN',
  BAD_PARAMS: 'team.joinError.BAD_PARAMS',
  UNSUPPORTED_VERSION: 'team.joinError.UNSUPPORTED_VERSION',
  INTERNAL: 'team.joinError.INTERNAL',
  NETWORK: 'team.joinError.NETWORK',
  PIN_MISMATCH: 'team.joinError.PIN_MISMATCH',
  LOST_ANSWER: 'team.joinError.LOST_ANSWER',
  NOT_STORED: 'team.joinError.NOT_STORED',
  NOT_STORED_device: 'team.joinError.NOT_STORED_device',
} as const

function keyOf<T extends Record<string, string>>(table: T, code: string, fallback: keyof T): T[keyof T] {
  return Object.hasOwn(table, code) ? table[code as keyof T] : table[fallback]
}

/** The team's state, kept current by the main process's pushes. */
export function useTeamState(): TeamView | null {
  const [view, setView] = useState<TeamView | null>(null)
  useEffect(() => {
    let live = true
    void window.workspace.team.get().then((next) => {
      if (live) setView(next)
    })
    const off = window.workspace.team.onChanged((next) => setView((current) => ({ ...next, ...(current?.suggestedDeviceName ? { suggestedDeviceName: current.suggestedDeviceName } : {}) })))
    return () => {
      live = false
      off()
    }
  }, [])
  return view
}

/** Whether the connection stopped for a reason the user must resolve (the Settings list marks the section). */
export function teamNeedsUser(view: TeamView | null): boolean {
  return view !== null && view.enabled && view.status === 'stopped'
}

/**
 * Settings → Team (`team-membership`): the switch with the statement of what the operator can read, the state line,
 * joining from an invite link, and the joined view — team, member, device name, server, members, Reconnect, Leave,
 * Remove from this computer. Everything comes from the main process's projection; it never sees the credential.
 *
 * **The invite link applies only through its own controls** (`terminal-preferences`' third exception): pasting it and
 * leaving the field connects to nothing; Continue inspects, Join redeems.
 */
export function TeamSection(): React.JSX.Element {
  const { t } = useTranslation()
  const view = useTeamState()
  const [joining, setJoining] = useState(false)

  if (!view) return <p className="text-xs text-ink-faint">{t('common.loading')}</p>
  const showJoin = view.enabled && (view.membership === null || joining)

  return (
    <section role="group" aria-label={t('team.label')}>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label={t('team.enable')}
          checked={view.enabled}
          onChange={(event) => void window.workspace.team.setEnabled(event.target.checked)}
        />
        <span className="text-sm text-ink">{t('team.enable')}</span>
      </label>
      <p className={HINT_CLASS}>{t('team.operatorStatement')}</p>

      <StateLine view={view} />

      {view.loadIssue ? (
        <p role="status" className="mt-2 text-xs text-danger">
          {t(`team.loadIssue.${view.loadIssue}`)}
        </p>
      ) : null}

      {view.membership ? <Joined view={view} onPasteNew={() => setJoining(true)} /> : null}
      {showJoin ? <JoinForm suggestedDeviceName={view.suggestedDeviceName ?? ''} onDone={() => setJoining(false)} /> : null}
    </section>
  )
}

function StateLine({ view }: { view: TeamView }): React.JSX.Element {
  const { t } = useTranslation()
  // The next attempt as a clock time: a relative "in N s" would need its own wording, and the wait is up to minutes.
  const status = t(`team.status.${view.status}`, {
    when: view.nextAt !== undefined ? formatTime(new Date(view.nextAt), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '',
  })
  const stopped = view.status === 'stopped' || (view.status === 'unjoined' && view.reason === 'REVOKED')
  let detail = ''
  if (view.reason !== undefined) {
    if (stopped) {
      const code = view.reason === 'UNSUPPORTED_VERSION' && view.olderSide ? `UNSUPPORTED_VERSION_${view.olderSide}` : view.reason
      detail = t(keyOf(STOP_KEYS, code, 'FAULT'), { device: view.deviceName ?? '' })
    } else if (view.status === 'reconnecting') {
      detail = t(keyOf(RETRY_KEYS, view.reason, 'SERVER_CLOSED'))
    }
  }
  return (
    <div className="mt-3 text-xs">
      <p role="status" aria-label={t('team.label')} className={stopped ? 'text-danger' : 'text-ink'}>
        {status} {detail}
      </p>
      {view.status === 'stopped' && view.reason !== 'PIN_MISMATCH' ? (
        <button type="button" className={`${BUTTON_CLASS} mt-2`} onClick={() => void window.workspace.team.reconnect()}>
          {t('team.reconnect')}
        </button>
      ) : null}
    </div>
  )
}

function Joined({ view, onPasteNew }: { view: TeamView; onPasteNew: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const m = view.membership!
  const connected = view.status === 'connected'
  return (
    <div className={SECTION_CLASS}>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-faint">{t('team.team')}</dt>
        <dd className="text-ink">{m.team}</dd>
        <dt className="text-ink-faint">{t('team.member')}</dt>
        <dd className="text-ink">
          {m.member.displayName} (@{m.member.handle})
        </dd>
        <dt className="text-ink-faint">{t('team.server')}</dt>
        <dd className="select-text break-all font-mono text-ink">
          {m.server}
          {m.pinned ? <span className="ml-2 font-sans text-ink-faint">({t('team.pinned')})</span> : null}
        </dd>
      </dl>

      <DeviceName name={m.device} connected={connected} offered={m.operations.includes('device.rename')} />
      <Members view={view} />

      {view.status === 'stopped' && view.reason === 'PIN_MISMATCH' ? (
        <button type="button" className={`${BUTTON_CLASS} mt-3`} onClick={onPasteNew}>
          {t('team.pasteNew')}
        </button>
      ) : null}

      <Leave view={view} />
    </div>
  )
}

/** A typed value: applies on Enter or blur, Esc restores (`terminal-preferences`). The server's answer is shown. */
function DeviceName({ name, connected, offered }: { name: string; connected: boolean; offered: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState(name)
  const [shown, setShown] = useState(name)
  const [error, setError] = useState<string | null>(null)
  if (shown !== name) {
    setShown(name)
    setText(name)
  }
  const commit = async (): Promise<void> => {
    if (text.trim() === name || !connected || !offered) {
      setText(name)
      return
    }
    const result = await window.workspace.team.rename(text)
    if (result.ok) setError(null)
    else {
      setError(result.error === 'BAD_PARAMS' ? t('team.renameRefused') : t('settings.writeFailed'))
      setText(name)
    }
  }
  return (
    <>
      <label className={LABEL_CLASS} htmlFor="team-device-name">
        {t('team.device')}
      </label>
      <input
        id="team-device-name"
        aria-label={t('team.device')}
        className={`${INPUT_CLASS} w-full`}
        value={text}
        disabled={!connected || !offered}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit()
          if (event.key === 'Escape' && text !== name) {
            event.stopPropagation()
            setText(name)
          }
        }}
      />
      {!offered ? <p className={HINT_CLASS}>{t('team.renameNotOffered')}</p> : !connected ? <p className={HINT_CLASS}>{t('team.renameOffline')}</p> : null}
      <FieldError message={error} />
    </>
  )
}

function Members({ view }: { view: TeamView }): React.JSX.Element | null {
  const { t } = useTranslation()
  const m = view.membership!
  if (m.members.length === 0) return null
  return (
    <div className="mt-4 text-xs">
      <p className="text-ink-faint">
        {t('team.members')}
        {m.membersFetchedAt !== undefined ? ` · ${t('team.membersFetched', { when: formatDateTime(new Date(m.membersFetchedAt)) })}` : ''}
      </p>
      <ul aria-label={t('team.members')} className="mt-1 space-y-0.5">
        {m.members.map((member) => (
          <li key={member.handle} className="text-ink">
            {member.displayName} <span className="text-ink-faint">@{member.handle}</span>
            {member.you ? <span className="ml-1 text-ink-faint">({t('team.you')})</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Leave({ view }: { view: TeamView }): React.JSX.Element {
  const { t } = useTranslation()
  const m = view.membership!
  const connected = view.status === 'connected'
  const [asking, setAsking] = useState<'leave' | 'remove' | null>(null)
  const [count, setCount] = useState<number | null | 'pending'>('pending')
  const [error, setError] = useState<string | null>(null)

  const askLeave = async (): Promise<void> => {
    setAsking('leave')
    setCount('pending')
    const preview = await window.workspace.team.leavePreview()
    setCount(preview ? preview.deviceCount : null)
  }
  const cancel = (event: React.KeyboardEvent): void => {
    if (asking && event.key === 'Escape') {
      event.stopPropagation()
      setAsking(null)
    }
  }

  const sentence =
    count === 'pending'
      ? t('team.leaveAskingCount')
      : count === null
        ? t('team.leaveUnknown')
        : count <= 1
          ? t('team.leaveLast', { team: m.team })
          : t('team.leaveOne', { team: m.team, count: count - 1 })

  return (
    <div className={SECTION_CLASS} onKeyDown={cancel}>
      {connected && m.operations.includes('device.leave') ? (
        <button type="button" className={BUTTON_CLASS} onClick={() => void askLeave()}>
          {t('team.leave')}
        </button>
      ) : (
        <>
          <p className={HINT_CLASS}>{t('team.leaveOffline')}</p>
          <button type="button" className={`${BUTTON_CLASS} mt-2`} onClick={() => setAsking('remove')}>
            {t('team.removeLocally')}
          </button>
        </>
      )}
      {asking === 'leave' ? (
        <div role="alertdialog" aria-label={t('team.leave')} className="mt-2 rounded border border-hairline bg-stage p-2 text-xs">
          <p className="text-ink">{sentence}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={BUTTON_CLASS}
              disabled={count === 'pending'}
              onClick={async () => {
                const result = await window.workspace.team.leave()
                if (result.ok) setAsking(null)
                else setError(t('team.leaveFailed'))
              }}
            >
              {t('team.leaveConfirm')}
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={() => setAsking(null)}>
              {t('team.invite.cancel')}
            </button>
          </div>
          <FieldError message={error} />
        </div>
      ) : null}
      {asking === 'remove' ? (
        <div role="alertdialog" aria-label={t('team.removeLocally')} className="mt-2 rounded border border-hairline bg-stage p-2 text-xs">
          <p className="text-ink">{t('team.removeLocallyStatement')}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={async () => {
                await window.workspace.team.removeLocally()
                setAsking(null)
              }}
            >
              {t('team.removeLocallyConfirm')}
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={() => setAsking(null)}>
              {t('team.invite.cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function JoinForm({ suggestedDeviceName, onDone }: { suggestedDeviceName: string; onDone: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [link, setLink] = useState('')
  const [inspected, setInspected] = useState<Extract<InspectView, { ok: true }> | null>(null)
  const [handle, setHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [deviceName, setDeviceName] = useState(suggestedDeviceName)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const errorText = (code: string, extra: { field?: string; deviceName?: string; olderSide?: string } = {}): string => {
    if (code === 'UNSUPPORTED_VERSION' && extra.olderSide) return t(keyOf(STOP_KEYS, `UNSUPPORTED_VERSION_${extra.olderSide}`, 'UNSUPPORTED_VERSION'))
    if (code === 'NOT_STORED' && extra.deviceName) return t('team.joinError.NOT_STORED_device', { device: extra.deviceName })
    return t(keyOf(JOIN_ERROR_KEYS, code, 'INTERNAL'), { field: extra.field ?? '', device: extra.deviceName ?? '' })
  }

  const inspect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await window.workspace.team.inspect(link)
    setBusy(false)
    if (result.ok) setInspected(result)
    else setError(errorText(result.error))
  }

  const join = async (): Promise<void> => {
    if (!inspected) return
    setBusy(true)
    setError(null)
    const result = await window.workspace.team.join({
      link,
      deviceName,
      ...(inspected.kind === 'member' ? { handle, displayName } : {}),
    })
    setBusy(false)
    if (result.ok) {
      onDone()
      return
    }
    setError(errorText(result.error, result))
    // An invite that cannot be used clears the form; a field the user can change keeps it (`team-membership`).
    if (result.error === 'INVITE_UNKNOWN' || result.error === 'INVITE_EXPIRED' || result.error === 'INVITE_USED') setInspected(null)
  }

  return (
    <div className={SECTION_CLASS}>
      <label className={LABEL_CLASS} htmlFor="team-invite-link">
        {t('team.invite.label')}
      </label>
      <input
        id="team-invite-link"
        aria-label={t('team.invite.label')}
        className={`${INPUT_CLASS} w-full`}
        value={link}
        spellCheck={false}
        onChange={(event) => {
          setLink(event.target.value)
          setInspected(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && link.trim() !== '') void inspect()
        }}
      />
      <p className={HINT_CLASS}>{t('team.invite.hint')}</p>
      {!inspected ? (
        <button type="button" className={`${BUTTON_CLASS} mt-2`} disabled={busy || link.trim() === ''} onClick={() => void inspect()}>
          {t('team.invite.continue')}
        </button>
      ) : (
        <div className="mt-3 text-xs">
          <p role="status" aria-label={t('team.invite.label')} className="text-ink">
            {inspected.kind === 'member'
              ? t('team.invite.kindMember', { team: inspected.team })
              : t('team.invite.kindDevice', {
                  team: inspected.team,
                  name: inspected.member?.displayName ?? '',
                  handle: inspected.member?.handle ?? '',
                })}{' '}
            {inspected.expiresAt > 0 ? t('team.invite.expires', { when: formatDateTime(new Date(inspected.expiresAt)) }) : ''}
          </p>
          {inspected.kind === 'member' ? (
            <>
              <label className={LABEL_CLASS} htmlFor="team-handle">
                {t('team.invite.handle')}
              </label>
              <input
                id="team-handle"
                aria-label={t('team.invite.handle')}
                className={`${INPUT_CLASS} w-full`}
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
              />
              <p className={HINT_CLASS}>{t('team.invite.handleRule')}</p>
              <label className={LABEL_CLASS} htmlFor="team-display-name">
                {t('team.invite.displayName')}
              </label>
              <input
                id="team-display-name"
                aria-label={t('team.invite.displayName')}
                className={`${INPUT_CLASS} w-full`}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </>
          ) : null}
          <label className={LABEL_CLASS} htmlFor="team-new-device-name">
            {t('team.invite.deviceName')}
          </label>
          <input
            id="team-new-device-name"
            aria-label={t('team.invite.deviceName')}
            className={`${INPUT_CLASS} w-full`}
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
          />
          <div className="mt-3 flex gap-2">
            <button type="button" className={BUTTON_CLASS} disabled={busy} onClick={() => void join()}>
              {t('team.invite.join')}
            </button>
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={() => {
                setInspected(null)
                onDone()
              }}
            >
              {t('team.invite.cancel')}
            </button>
          </div>
        </div>
      )}
      <FieldError message={error} />
    </div>
  )
}
