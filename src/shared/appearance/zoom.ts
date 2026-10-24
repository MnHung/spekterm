/**
 * The interface zoom and theme choices shared by the main process and the renderer (`ui-appearance`).
 */

/** The zoom steps, in percent. 175 is the top: at 200% a 1280-px window is narrower than the regions' minimums. */
export const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175] as const

export const DEFAULT_ZOOM = 100

/** The theme choices; an unset preference is `system`. */
export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

/** The step nearest to `value`, the smaller on a tie; `undefined` for anything that is not a finite number. */
export function snapZoom(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  let best: number = ZOOM_STEPS[0]
  for (const step of ZOOM_STEPS) {
    // Strictly closer only: on a tie the earlier (smaller) step stays.
    if (Math.abs(step - value) < Math.abs(best - value)) best = step
  }
  return best
}

/** One step in `direction` from `current` (snapped first), clamped at the ends; `0` resets to the default. */
export function stepZoom(current: number | undefined, direction: -1 | 0 | 1): number {
  if (direction === 0) return DEFAULT_ZOOM
  const from = snapZoom(current) ?? DEFAULT_ZOOM
  const index = ZOOM_STEPS.indexOf(from as (typeof ZOOM_STEPS)[number])
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction))
  return ZOOM_STEPS[next]
}
