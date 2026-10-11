/**
 * project-website: The site serves spek's live demo (change spek-demo-on-the-website, design D1, D2).
 *
 * Fetches the demo page of the spek release pinned in `src/spek-demo.json` and writes it, unchanged, to
 * `dist/spek/demo/index.html` — only when every check passes:
 *
 * - its SHA-256 is the pin's (a tag can move; the hash is what makes the pin hold);
 * - the repository's content-hygiene matcher finds neither the maintainer's home path nor a listed word;
 * - it references no analytics: Google's analytics hosts, the site's measurement ID, the site's consent
 *   key. The origins check cannot see this — the site's own consent script is an inline script that adds
 *   the tag at run time, and every page passes the origins check while carrying it;
 * - it carries the third-party notices of what it bundles (a non-empty `#third-party-notices`);
 * - no string of its embedded data holds a remote Markdown image, read as CommonMark — so an image
 *   inside a code span or a fenced block, which renders as text, does not count, and one written by
 *   reference does. Raw HTML is not counted: spek renders Markdown without raw HTML, so an `<img>` there
 *   is shown as text and loads nothing.
 *
 * Runs right after `astro build`, which writes the sitemap and the search index — so the demo is in
 * neither — and before the origins check, which then reads the demo like any built file.
 *
 * Asynchronous (a fetch), so it does not use `lib.mjs`'s synchronous `main` / `selfTest`: an async run
 * would be read as "no problems". It sets its own exit code, as `check-live.mjs` does.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { parse } from 'node-html-parser'
import { MAINTAINER_HOME, hygieneHits, sha256 } from '../../scripts/lib/public-hygiene.mjs'
import { CONSENT_KEY, GA_MEASUREMENT_ID } from '../src/analytics.mjs'
import { DIST, HTML_OPTIONS, SITE_ROOT, fixtureDir } from './lib.mjs'

export const PIN_FILE = join(SITE_ROOT, 'src', 'spek-demo.json')
/** Where the demo is served: `/spek/demo/`. */
export const DEMO_FILE = 'spek/demo/index.html'

const FETCH_TIMEOUT_MS = 60_000
const ANALYTICS_MARKERS = ['googletagmanager.com', 'google-analytics.com', GA_MEASUREMENT_ID, CONSENT_KEY]
const DATA_PREFIX = 'window.__DEMO_DATA__ = '
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/** The pin: `{ tag, sha256 }`. */
export function readPin(file = PIN_FILE) {
  const pin = JSON.parse(readFileSync(file, 'utf8'))
  if (!/^v\d+\.\d+\.\d+$/.test(pin.tag ?? '') || !/^[0-9a-f]{64}$/.test(pin.sha256 ?? '')) {
    throw new Error(`${file}: expected { "tag": "v<major>.<minor>.<patch>", "sha256": "<64 hex>" }`)
  }
  return pin
}

export const demoUrl = (tag) => `https://raw.githubusercontent.com/spekhq/spek/${tag}/docs/demo.html`

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

function isRemoteUrl(url) {
  return REMOTE.test(url.trim()) && !/^data:/i.test(url.trim())
}

/** Every string anywhere in `value`. */
function* stringsOf(value) {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) for (const item of value) yield* stringsOf(item)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield key
      yield* stringsOf(item)
    }
  }
}

/** Remote image URLs in `markdown`, read as CommonMark: inline images and resolved image references. */
export function remoteImagesOf(markdown) {
  const tree = fromMarkdown(markdown)
  const definitions = new Map()
  const images = []
  const visit = (node) => {
    if (node.type === 'definition') definitions.set(node.identifier, node.url)
    if (node.type === 'image') images.push(node.url)
    if (node.type === 'imageReference') images.push({ reference: node.identifier })
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return images
    .map((image) => (typeof image === 'string' ? image : definitions.get(image.reference)))
    .filter((url) => typeof url === 'string' && isRemoteUrl(url))
}

/** The demo's embedded data, parsed from its data script; `null` when the page has none. */
function embeddedData(root) {
  for (const script of root.querySelectorAll('script')) {
    const text = script.textContent.trim()
    if (!text.startsWith(DATA_PREFIX)) continue
    return JSON.parse(text.slice(DATA_PREFIX.length).replace(/;\s*$/, ''))
  }
  return null
}

/**
 * Why the obtained demo must not be served; empty when it may. `hashes` replaces the hygiene list (the
 * self-test's control word).
 */
export function demoProblems(bytes, pin, { hashes } = {}) {
  const problems = []
  const actual = sha256Hex(bytes)
  if (actual !== pin.sha256) problems.push(`SHA-256 is ${actual}, the pin is ${pin.sha256}`)

  const text = bytes.toString('utf8')
  const hygiene = hygieneHits(text, hashes ? { hashes } : undefined)
  if (hygiene.homePath) problems.push("content hygiene: it contains the maintainer's home path")
  if (hygiene.words.length > 0) problems.push(`content hygiene: it contains listed words (${hygiene.words.join(', ')})`)

  for (const marker of ANALYTICS_MARKERS) {
    if (text.includes(marker)) problems.push(`it references analytics: ${marker}`)
  }

  const root = parse(text, HTML_OPTIONS)
  const notices = root.querySelector('#third-party-notices')
  if (!notices || notices.textContent.trim() === '') problems.push('it carries no third-party notices (#third-party-notices)')

  let data
  try {
    data = embeddedData(root)
  } catch (error) {
    problems.push(`its embedded data does not parse (${error.message})`)
  }
  if (data === null) problems.push('it has no embedded data to read')
  else if (data !== undefined) {
    for (const value of stringsOf(data)) {
      if (!value.includes('![')) continue
      for (const url of remoteImagesOf(value)) problems.push(`its content embeds a remote image: ${url}`)
    }
  }
  return problems
}

/**
 * Fetches the pinned demo from `url` and writes it under `dist` when it passes; returns the problems
 * (nothing is written when there are any).
 */
export async function addSpekDemo({ url, pin, dist, hashes }) {
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    return [`${url}: request failed (${error.message})`]
  }
  if (!response.ok) return [`${url}: status ${response.status}`]
  const bytes = Buffer.from(await response.arrayBuffer())
  const problems = demoProblems(bytes, pin, { hashes })
  if (problems.length > 0) return problems
  const target = join(dist, DEMO_FILE)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return []
}

// ---------------------------------------------------------------------------------------------
// Self-test: a local server stands in for GitHub.

const CONTROL_WORD = 'zebrafixtureword'

function demoPage({ notices = 'react@19.2.4 (MIT)\n\nMIT License', data = {}, extraHead = '' } = {}) {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c')
  const noticesElement = notices === null ? '' : `<script type="text/plain" id="third-party-notices">${notices}</script>`
  return Buffer.from(
    `<!DOCTYPE html><html lang="en"><head><title>spek demo</title>${noticesElement}${extraHead}</head>` +
      `<body><div id="root"></div><script>${DATA_PREFIX}${payload};</script><script>void 0;</script></body></html>`,
  )
}

/** Content an author may legitimately write: image syntax shown as code, and raw HTML. */
const BENIGN = {
  specDetails: {
    a: {
      content:
        'Write `![x](https://example.com/a.png)` for an image.\n\n```md\n![y](https://example.com/b.png)\n```\n\n' +
        'Discuss `<img src="https://example.com/c.png">` in prose. A local ![z](./z.png) and ![d](data:image/png;base64,AA).',
    },
  },
}

async function selfTest() {
  const pages = {
    clean: demoPage({ data: BENIGN }),
    home: demoPage({ data: { specs: [{ path: `${MAINTAINER_HOME}/repo/openspec/specs/a/spec.md` }] } }),
    word: demoPage({ data: { specDetails: { a: { content: `a ${CONTROL_WORD} b` } } } }),
    gtag: demoPage({ extraHead: '<script>var s="https://www.googletagmanager.com/gtag/js?id=G-OTHER"</script>' }),
    gaHost: demoPage({ extraHead: '<script>var s="https://www.google-analytics.com/g/collect"</script>' }),
    consent: demoPage({ data: { k: CONSENT_KEY } }),
    noNotices: demoPage({ notices: null }),
    emptyNotices: demoPage({ notices: '  ' }),
    inlineImage: demoPage({ data: { specDetails: { a: { content: 'See ![shot](https://img.example.com/a.png).' } } } }),
    referenceImage: demoPage({ data: { changeDetails: { c: { content: 'See ![shot][s].\n\n[s]: //img.example.com/b.png' } } } }),
    noData: Buffer.from('<!DOCTYPE html><html><head><script type="text/plain" id="third-party-notices">x</script></head><body></body></html>'),
  }
  const server = createServer((req, res) => {
    const page = pages[new URL(req.url, 'http://x').pathname.slice(1)]
    res.writeHead(page ? 200 : 404)
    res.end(page ?? '')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const pinOf = (bytes) => ({ tag: 'v0.0.0', sha256: sha256Hex(bytes) })
  const misses = []
  const dist = fixtureDir({ 'index.html': '<!doctype html>' })
  try {
    const clean = await addSpekDemo({ url: `${origin}/clean`, pin: pinOf(pages.clean), dist })
    if (clean.length > 0) misses.push(`the clean demo was refused: ${clean.join('; ')}`)
    else if (!readFileSync(join(dist, DEMO_FILE)).equals(pages.clean)) misses.push('the clean demo was not written byte for byte')
    rmSync(join(dist, 'spek'), { recursive: true, force: true })

    const cases = [
      { label: 'a hash mismatch', name: 'clean', pin: { tag: 'v0.0.0', sha256: '0'.repeat(64) }, expect: 'the pin is' },
      { label: 'a home path', name: 'home', expect: "maintainer's home path" },
      { label: 'a listed word', name: 'word', hashes: new Set([sha256(CONTROL_WORD)]), expect: 'listed words' },
      { label: 'a Google tag with another ID', name: 'gtag', expect: 'googletagmanager.com' },
      { label: 'the Google Analytics host', name: 'gaHost', expect: 'google-analytics.com' },
      { label: "the site's consent key", name: 'consent', expect: CONSENT_KEY },
      { label: 'no notices', name: 'noNotices', expect: 'no third-party notices' },
      { label: 'empty notices', name: 'emptyNotices', expect: 'no third-party notices' },
      { label: 'a remote inline image', name: 'inlineImage', expect: 'https://img.example.com/a.png' },
      { label: 'a remote image by reference', name: 'referenceImage', expect: '//img.example.com/b.png' },
      { label: 'no embedded data', name: 'noData', expect: 'no embedded data' },
      { label: 'a failed request', name: 'missing', pin: { tag: 'v0.0.0', sha256: '0'.repeat(64) }, expect: 'status 404' },
    ]
    for (const { label, name, pin, hashes, expect } of cases) {
      const problems = await addSpekDemo({ url: `${origin}/${name}`, pin: pin ?? pinOf(pages[name]), dist, hashes })
      if (!problems.some((p) => p.includes(expect))) {
        misses.push(`"${label}" was not caught (expected "${expect}", got: ${problems.join('; ') || 'none'})`)
      }
      if (existsSync(join(dist, DEMO_FILE))) {
        misses.push(`"${label}" wrote the demo`)
        rmSync(join(dist, 'spek'), { recursive: true, force: true })
      }
    }
  } finally {
    server.close()
    rmSync(dist, { recursive: true, force: true })
  }
  if (misses.length > 0) throw new Error(`self-test failed:\n  - ${misses.join('\n  - ')}`)
  console.log('add-spek-demo: self-test passed (the clean demo is written byte for byte; 12 refusals caught, nothing written)')
}

/** Run only when executed — `check-content` imports the pin helpers, and must not fetch. */
const executed = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (executed) try {
  if (process.argv.includes('--self-test')) {
    await selfTest()
  } else {
    const pin = readPin()
    const url = demoUrl(pin.tag)
    const problems = await addSpekDemo({ url, pin, dist: DIST })
    if (problems.length > 0) {
      console.error(`add-spek-demo: ${url} was not served — ${problems.length} problem(s)\n  - ${problems.join('\n  - ')}`)
      process.exitCode = 1
    } else {
      console.log(`add-spek-demo: spek ${pin.tag}'s demo written to dist/${DEMO_FILE}`)
    }
  }
} catch (error) {
  console.error(`add-spek-demo: ${error.message}`)
  process.exitCode = 1
}
