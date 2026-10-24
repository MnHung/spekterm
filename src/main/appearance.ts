import { BrowserWindow, nativeTheme, type WebContents } from 'electron'
import { DEFAULT_ZOOM } from '@shared/appearance/zoom'
import type { PreferencesStore } from './preferences-store'

/**
 * The theme and the interface zoom, applied by the main process (`ui-appearance`).
 *
 * - **`nativeTheme.themeSource` is the one switch**: it decides the renderer's `prefers-color-scheme`, which the
 *   CSS and the terminal, editor and Graph read, and the engine-drawn controls. The renderer never decides colors
 *   from the stored preference (design D1).
 * - **The zoom is applied on every `did-navigate`**, which is early enough for the page's first script to run at
 *   it (measured; `dom-ready` and `did-finish-load` are too late). Chromium also remembers a zoom per full URL,
 *   so without this a reload or an unpackaged restart would take Chromium's value, not the stored one.
 */

/** The window background per palette: the `--color-shell` token of each (`index.css`, `theme-palette.test.mjs`). */
export const WINDOW_BACKGROUND = { dark: '#07090c', light: '#fbfcfd' } as const

let preferences: PreferencesStore | null = null

export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
}

/** Set the theme source from the stored preference. Called before the first window and on every change. */
export function applyTheme(): void {
  if (!preferences) return
  nativeTheme.themeSource = preferences.ui().theme ?? 'system'
}

/** The stored zoom as a zoom factor. */
export function zoomFactor(): number {
  return (preferences?.zoom() ?? DEFAULT_ZOOM) / 100
}

/** Apply the stored zoom to every window. */
export function applyZoom(): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.setZoomFactor(zoomFactor())
}

/** Keep a window's zoom the stored one across its navigations (reloads included). */
export function followZoom(contents: WebContents): void {
  contents.on('did-navigate', () => contents.setZoomFactor(zoomFactor()))
}

/**
 * Read the preferences from here on, apply the theme, and keep every window's background on the resolved
 * palette — a change of the choice or of the operating system's appearance fires `updated`; without it a reload
 * or a growing window would show the other palette's background.
 */
export function configureAppearance(store: PreferencesStore): void {
  preferences = store
  applyTheme()
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(windowBackground())
  })
}
