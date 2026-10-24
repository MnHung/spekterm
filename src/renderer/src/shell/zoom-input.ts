/**
 * The zoom keys and the `Ctrl`-wheel gesture (`ui-appearance`, "Keys and the mouse wheel change the zoom"), as pure
 * decisions; `KeyboardNavigation` owns the listeners.
 */

export type ZoomDirection = -1 | 0 | 1

export interface ZoomKey {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * The zoom a key asks for, or `null` for any other key.
 *
 * - `Ctrl` (`Cmd` on macOS), **never with `Alt`**: `AltGr` is `Ctrl+Alt` on some layouts.
 * - `=` / `+` zoom in and `0` resets **with or without Shift**: `Ctrl++` is Shift+`=` on a US layout, AZERTY needs
 *   Shift for the main row's `0`, and xterm sends nothing for either.
 * - `-` zooms out **only without Shift**: `Ctrl+Shift+-` is `^_` (undo in readline and zsh) and must keep reaching
 *   the pty.
 * - The keypad by `event.code`, whatever NumLock makes of `event.key`.
 */
export function zoomKeyDirection(event: ZoomKey, isMac: boolean): ZoomDirection | null {
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!modifier || event.altKey) return null
  if (event.code === 'NumpadAdd') return 1
  if (event.code === 'NumpadSubtract') return -1
  if (event.code === 'Numpad0') return 0
  if (event.key === '=' || event.key === '+') return 1
  if (event.key === '0') return 0
  if (event.key === '-' && !event.shiftKey) return -1
  return null
}

/** One event of at least this many device pixels is one notch: one step. */
export const NOTCH_DEVICE_PX = 40
/** Smaller movements add up to this much before they take a step. */
export const ACCUMULATED_STEP_PX = 100
/** Quiet time after which a partial sum is dropped. */
export const ACCUMULATION_RESET_MS = 300

export interface WheelInput {
  deltaY: number
  /** 0 = pixels, 1 = lines, 2 = pages (`WheelEvent.deltaMode`). */
  deltaMode: number
  timeStamp: number
}

/**
 * Turns `Ctrl`-wheel events into zoom steps.
 *
 * `deltaY` is in CSS pixels, which shrink as the zoom grows (the same notch of -120 arrives as -80 at 150%), so
 * it is converted to device pixels first: a notch is a notch at every zoom. A touchpad sends many small events;
 * they accumulate, so a gesture moves the zoom in proportion to its length rather than one step per event.
 */
export function createWheelZoom(lineHeightPx = 16, pageHeightPx = 800): (event: WheelInput, zoom: number) => ZoomDirection | null {
  let sum = 0
  let last = Number.NEGATIVE_INFINITY
  return (event, zoom) => {
    const unit = event.deltaMode === 1 ? lineHeightPx : event.deltaMode === 2 ? pageHeightPx : 1
    const device = event.deltaY * unit * (zoom / 100)
    if (device === 0) return null
    if (Math.abs(device) >= NOTCH_DEVICE_PX) {
      sum = 0
      last = event.timeStamp
      // Wheel up (negative deltaY) zooms in.
      return device < 0 ? 1 : -1
    }
    if (event.timeStamp - last > ACCUMULATION_RESET_MS || Math.sign(sum) !== Math.sign(device)) sum = 0
    last = event.timeStamp
    sum += device
    if (Math.abs(sum) < ACCUMULATED_STEP_PX) return null
    const direction = sum < 0 ? 1 : -1
    sum -= Math.sign(sum) * ACCUMULATED_STEP_PX
    return direction
  }
}
