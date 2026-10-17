import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { encode } from 'uqr'

import { relativeTime } from '@shared/i18n/locale'
import { useNow } from '../../useNow'
import { listenLine, type RemoteState, useRemoteState } from '../../remote/useRemoteState'

const INPUT_CLASS = 'w-full rounded border border-hairline bg-stage px-2 py-1 text-ink outline-none focus:border-accent'
const BUTTON_CLASS =
  'rounded border border-hairline px-2 py-[3px] text-xs hover:bg-stage focus:outline-none focus-visible:ring-1 focus-visible:ring-accent'
const SECTION_CLASS = 'mt-4 border-t border-hairline pt-3'

/**
 * Remote access, as a section of Settings (`remote-access`; `settings-sections` design D6): the summary line, the
 * switch with the statement of what a paired device can do, the port and addresses, the certificate fingerprint,
 * pairing (QR code and link), the paired devices with Revoke, and Reset. It used to be a dialog of its own, opened
 * after closing Settings.
 *
 * Everything it shows comes from the main process's projection; it never sees a credential, hash or key.
 * The pairing code is inside the link, which it must show. **Leaving the section ends the code**: it unmounts
 * when the user switches sections or closes Settings.
 */
export function RemoteSection(): React.JSX.Element {
  const { t } = useTranslation()
  const state = useRemoteState()
  const [pairing, setPairing] = useState(false)

  // The pairing view closing for any reason ends its code (`remote-access`).
  useEffect(() => () => window.workspace.remote.cancelPairing(), [])

  return (
    <>
      <RemoteSummary state={state} />
      {state ? (
        <DialogBody state={state} pairing={pairing} setPairing={setPairing} />
      ) : (
        <p className="mt-3 text-xs text-ink-faint">{t('common.loading')}</p>
      )}
    </>
  )
}

/**
 * The one-line summary (off, on with devices, or failed), first in the section. Its group label is the probes'
 * carrier for the `terminal-preferences` scenarios that count devices.
 */
function RemoteSummary({ state }: { state: RemoteState | null }): React.JSX.Element {
  const { t } = useTranslation()
  let line = t('remote.section.off')
  if (state?.enabled) {
    line =
      state.listen.status === 'error'
        ? t('remote.section.failed', { cause: listenLine(state, t) })
        : t('remote.section.on', {
            devices: state.devices.length,
            connected: state.devices.filter((device) => device.connected).length,
          })
  }
  return (
    <section role="group" aria-label={t('remote.section.label')} className="text-xs">
      <p role="status" className={state?.enabled && state.listen.status === 'error' ? 'text-danger' : 'text-ink'}>
        {line}
      </p>
    </section>
  )
}

/**
 * Esc while an inline confirmation is open cancels it and stops there, so it does not also close Settings
 * (`settings-sections` D2).
 */
function cancelOnEscape(asking: boolean, cancel: () => void): (event: React.KeyboardEvent) => void {
  return (event) => {
    if (asking && event.key === 'Escape') {
      event.stopPropagation()
      cancel()
    }
  }
}

function DialogBody({
  state,
  pairing,
  setPairing,
}: {
  state: RemoteState
  pairing: boolean
  setPairing: (open: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const listenFailed = state.listen.status === 'error'

  return (
    <>
      {state.resetNotice ? (
        <div role="status" className="mt-3 rounded border border-hairline bg-stage p-2 text-xs text-ink">
          <p>{t(`remote.resetNotice.${state.resetNotice.reason}`)}</p>
          <button type="button" className={`${BUTTON_CLASS} mt-2`} onClick={() => window.workspace.remote.dismissNotice()}>
            {t('remote.dismissNotice')}
          </button>
        </div>
      ) : null}

      <label className="mt-3 flex items-center gap-2">
        <input
          type="checkbox"
          aria-label={t('remote.enable')}
          checked={state.enabled}
          onChange={(event) => {
            if (!event.target.checked && pairing) setPairing(false)
            void window.workspace.remote.setEnabled(event.target.checked)
          }}
        />
        <span className="text-sm text-ink">{t('remote.enable')}</span>
      </label>
      <p className="mt-1 text-xs text-ink-faint">{t('remote.powerStatement')}</p>
      {state.enabled ? (
        <p role={listenFailed ? 'alert' : 'status'} className={`mt-2 text-xs ${listenFailed ? 'text-danger' : 'text-ink-faint'}`}>
          {listenLine(state, t)}
        </p>
      ) : null}

      <PortField port={state.port} />
      <AddressField address={state.additionalAddress} />

      {state.fingerprint ? (
        <div className="mt-3 text-xs">
          <p className="text-ink-faint">{t('remote.fingerprint')}</p>
          <p aria-label={t('remote.fingerprint')} className="select-text break-all font-mono text-ink">
            {state.fingerprint}
          </p>
        </div>
      ) : null}
      {state.enabled ? (
        <div className="mt-2 text-xs">
          <p className="text-ink-faint">{t('remote.addresses')}</p>
          <p className="select-text break-all font-mono text-ink">{state.addresses.join(', ')}</p>
        </div>
      ) : null}

      {state.enabled ? <PairingSection state={state} pairing={pairing} setPairing={setPairing} /> : null}

      <Devices state={state} />
      <ResetSection />
    </>
  )
}

/**
 * The port applies through "Use port" or Enter, **never on blur** (`remote-access`): a port change restarts the
 * listener and drops connected devices, so it is a deliberate action. A typed port that was not applied stays,
 * marked as such; Esc restores the stored one.
 */
function PortField({ port }: { port: number }): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(String(port))
  const [invalid, setInvalid] = useState(false)
  // A port taken elsewhere (another window, a reset) replaces what the field shows — adjusted during render.
  const [shownPort, setShownPort] = useState(port)
  if (shownPort !== port) {
    setShownPort(port)
    setValue(String(port))
  }
  const pending = value.trim() !== String(port)
  const apply = (): void => {
    const parsed = Number(value)
    void window.workspace.remote.setPort(parsed).then((result) => setInvalid(!result.ok))
  }
  return (
    <div className="mt-3">
      <label className="block text-xs text-ink-faint" htmlFor="remote-port">
        {t('remote.port')}
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id="remote-port"
          aria-label={t('remote.port')}
          inputMode="numeric"
          className={INPUT_CLASS}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') apply()
            if (event.key === 'Escape' && pending) {
              event.stopPropagation()
              setInvalid(false)
              setValue(String(port))
            }
          }}
        />
        <button type="button" className={`${BUTTON_CLASS} shrink-0`} onClick={apply}>
          {t('remote.applyPort')}
        </button>
      </div>
      <p className={`mt-1 text-xs ${pending ? 'text-accent' : 'text-ink-faint'}`}>
        {pending ? t('remote.portNotApplied') : t('remote.portHint')}
      </p>
      {invalid ? <p role="alert" className="mt-1 text-xs text-danger">{t('remote.portInvalid')}</p> : null}
    </div>
  )
}

/** The additional address applies on Enter or blur (`settings-sections` D2): it only changes the pairing link. */
function AddressField({ address }: { address: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(address ?? '')
  const [invalid, setInvalid] = useState(false)
  const [shownAddress, setShownAddress] = useState(address)
  if (shownAddress !== address) {
    setShownAddress(address)
    setValue(address ?? '')
  }
  const save = (): void => {
    const trimmed = value.trim()
    if (trimmed === (address ?? '')) return
    void window.workspace.remote
      .setAdditionalAddress(trimmed === '' ? null : trimmed)
      .then((result) => setInvalid(!result.ok))
  }
  return (
    <div className="mt-3">
      <label className="block text-xs text-ink-faint" htmlFor="remote-address">
        {t('remote.additionalAddress')}
      </label>
      <input
        id="remote-address"
        aria-label={t('remote.additionalAddress')}
        className={`${INPUT_CLASS} mt-1`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
          if (event.key === 'Escape' && value !== (address ?? '')) {
            event.stopPropagation()
            setInvalid(false)
            setValue(address ?? '')
          }
        }}
      />
      <p className="mt-1 text-xs text-ink-faint">{t('remote.additionalAddressHint')}</p>
      {invalid ? <p role="alert" className="mt-1 text-xs text-danger">{t('remote.additionalAddressInvalid')}</p> : null}
    </div>
  )
}

function PairingSection({
  state,
  pairing,
  setPairing,
}: {
  state: RemoteState
  pairing: boolean
  setPairing: (open: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const now = useNow(1_000)
  const live = pairing ? state.pairing : null

  if (!live) {
    return (
      <div className={SECTION_CLASS}>
        <button
          type="button"
          className={`${BUTTON_CLASS} text-accent`}
          onClick={() => {
            setPairing(true)
            void window.workspace.remote.startPairing()
          }}
        >
          {t('remote.pair')}
        </button>
      </div>
    )
  }

  const remaining = Math.max(0, Math.round((live.expiresAt - now) / 1000))
  const time = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
  return (
    <div className={SECTION_CLASS}>
      <p className="text-xs text-ink-faint">{t('remote.pairingHint')}</p>
      <QrCode text={live.link} />
      <label className="mt-2 block text-xs text-ink-faint" htmlFor="remote-pairing-link">
        {t('remote.pairingLink')}
      </label>
      <input
        id="remote-pairing-link"
        aria-label={t('remote.pairingLink')}
        readOnly
        className={`${INPUT_CLASS} mt-1 font-mono text-xs`}
        value={live.link}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-ink-faint">{t('remote.pairingExpires', { time })}</p>
        <button
          type="button"
          className={BUTTON_CLASS}
          onClick={() => {
            setPairing(false)
            window.workspace.remote.cancelPairing()
          }}
        >
          {t('remote.pairDone')}
        </button>
      </div>
    </div>
  )
}

/** The link as a QR code, drawn from the module matrix: no markup string is ever injected. */
function QrCode({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation()
  const { path, size } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 })
    let d = ''
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`
      }),
    )
    return { path: d, size: qr.size }
  }, [text])
  return (
    <svg
      role="img"
      aria-label={t('remote.qr')}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="mx-auto mt-2 h-48 w-48 rounded bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  )
}

function Devices({ state }: { state: RemoteState }): React.JSX.Element {
  const { t } = useTranslation()
  const now = useNow(30_000)
  // **Revoking asks first** (`remote-access`): the device has to pair again.
  const [asking, setAsking] = useState<string | null>(null)
  return (
    <div className={SECTION_CLASS}>
      <p className="text-xs text-ink-faint">{t('remote.devices')}</p>
      {state.devices.length === 0 ? (
        <p className="mt-1 text-xs text-ink-faint">{t('remote.noDevices')}</p>
      ) : (
        <ul aria-label={t('remote.devices')} className="mt-1 space-y-1">
          {state.devices.map((device) => (
            <li key={device.id} className="flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <p className="truncate text-ink">
                  {device.name}
                  {device.model ? <span className="text-ink-faint"> · {device.model}</span> : null}
                </p>
                <p className="text-ink-faint">
                  {device.connected
                    ? t('remote.connected')
                    : device.lastSeenAt
                      ? t('remote.lastSeen', { time: relativeTime(device.lastSeenAt, now) })
                      : t('remote.neverSeen')}
                </p>
              </div>
              {asking === device.id ? (
                <div className="flex shrink-0 items-center gap-2" onKeyDown={cancelOnEscape(true, () => setAsking(null))}>
                  <span className="text-ink">{t('remote.revokeConfirm')}</span>
                  <button
                    type="button"
                    autoFocus
                    aria-label={t('remote.revokeConfirmButton', { name: device.name })}
                    className={`${BUTTON_CLASS} text-danger`}
                    onClick={() => {
                      setAsking(null)
                      void window.workspace.remote.revoke(device.id)
                    }}
                  >
                    {t('remote.revokeButton')}
                  </button>
                  <button type="button" className={BUTTON_CLASS} onClick={() => setAsking(null)}>
                    {t('common.cancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  aria-label={t('remote.revoke', { name: device.name })}
                  className={`${BUTTON_CLASS} shrink-0`}
                  onClick={() => setAsking(device.id)}
                >
                  {t('remote.revokeButton')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ResetSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  return (
    <div className={SECTION_CLASS} onKeyDown={cancelOnEscape(confirming, () => setConfirming(false))}>
      <p className="text-xs text-ink-faint">{t('remote.resetHint')}</p>
      {confirming ? (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className={`${BUTTON_CLASS} text-danger`}
            onClick={() => {
              setConfirming(false)
              void window.workspace.remote.reset()
            }}
          >
            {t('remote.resetConfirm')}
          </button>
          <button type="button" className={BUTTON_CLASS} onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <button type="button" className={`${BUTTON_CLASS} mt-2`} onClick={() => setConfirming(true)}>
          {t('remote.reset')}
        </button>
      )}
    </div>
  )
}
