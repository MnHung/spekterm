import { net } from 'electron'

import type { ReleaseFetch } from './update-release-check'

/**
 * The telling backend's one request, through the browser engine's network stack (as `electron-updater` does on
 * Linux), so both backends honour the same proxy settings. Its own file so that the network allow-list
 * (`scripts/network-surface.test.mjs`) names exactly this use.
 */
export const releaseFetch: ReleaseFetch = (url, init) => net.fetch(url, init)
