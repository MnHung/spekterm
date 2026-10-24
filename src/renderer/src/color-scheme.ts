import { useSyncExternalStore } from 'react'

/**
 * The light or dark palette in effect (`ui-appearance`), for the consumers that cannot read CSS variables: the
 * terminal, the editor and the side panel's Graph.
 *
 * **It reads `prefers-color-scheme`, never the stored preference** (design D1): the main process sets
 * `nativeTheme.themeSource` from the preference, and the renderer's media query — the same one the CSS palette
 * uses — follows it, including System following the operating system. Two sources would be two answers.
 */
export type ColorScheme = 'dark' | 'light'

const QUERY = '(prefers-color-scheme: dark)'

export function currentColorScheme(): ColorScheme {
  return window.matchMedia(QUERY).matches ? 'dark' : 'light'
}

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(QUERY)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

/** The palette in effect, re-rendering on every change. */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, currentColorScheme)
}
