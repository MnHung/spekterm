import { type CheckAnswer, type TellingBackend, UpdateFailureError } from './update-coordinator'

/**
 * The telling backend (`auto-update`, design U1): macOS, and a Linux build that cannot replace its file.
 *
 * One request to GitHub's "latest release" endpoint, which excludes drafts and pre-releases. **Only `tag_name` is
 * read** (U2): the release's name, notes and `html_url` never leave this function — the link the user opens is
 * built from the version (`releasePageUrl`).
 *
 * The request function is injected (`update-net.ts` passes Electron's `net.fetch`): importing `electron` here would
 * keep node:test from loading this module.
 */

export const LATEST_RELEASE_API = 'https://api.github.com/repos/spekhq/spekterm/releases/latest'
const TIMEOUT_MS = 15_000

export type ReleaseFetch = (url: string, init: RequestInit) => Promise<Response>

export function createTellingBackend(
  options: { request: ReleaseFetch; url?: string; timeoutMs?: number },
): TellingBackend {
  const url = options.url ?? LATEST_RELEASE_API
  const request = options.request
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  return {
    kind: 'telling',
    async check(): Promise<CheckAnswer> {
      let response: Response
      try {
        response = await request(url, {
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        throw new UpdateFailureError('network', error instanceof Error ? error.message : String(error))
      }
      // No release at all yet: nothing newer.
      if (response.status === 404) return null
      if (response.status === 403 || response.status === 429) {
        throw new UpdateFailureError('rate-limited', `HTTP ${response.status}`)
      }
      if (!response.ok) throw new UpdateFailureError('other', `HTTP ${response.status}`)
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new UpdateFailureError('unexpected-answer', 'not JSON')
      }
      const tag = (body as { tag_name?: unknown } | null)?.tag_name
      if (typeof tag !== 'string') throw new UpdateFailureError('unexpected-answer', 'no tag_name')
      // Parsed by the coordinator, which fails a tag that is not a version.
      return { latest: tag }
    },
  }
}
