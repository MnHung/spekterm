/**
 * project-website: The site publishes its third-party notices (design D11).
 *
 * Turns the shipped-module record written during the build (`collect-notice-modules.mjs`) into
 * `dist/third-party-notices.txt`, with the desktop artifact's helpers so there is one
 * implementation of "package root → license entry". Packages whose shipped files are not reached
 * through module ids are added by name:
 * - Pagefind: its UI files are written into `dist/pagefind/` by the Pagefind indexer, not bundled.
 *   (`pagefind` carries the license; the platform binary package is left out so the notices do not
 *   depend on the machine that built them.)
 * - expressive-code: `ec.*.js` / `ec.*.css` are emitted as assets with no originating module id
 *   (measured).
 * Listing a package that turns out not to ship is harmless; missing one is not.
 *
 * `--self-test` checks that the generator still lists the packages known to ship; the generator is
 * otherwise its own only carrier (a package it misses would not turn anything red — recorded as
 * such in the scenario-coverage table).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dedupeEntries,
  dedupeNotices,
  legalCommentsOf,
  licenseEntryOf,
  packageRootOf,
  packageRootsOf,
  renderSummary,
} from '../../scripts/lib/third-party-licenses.mjs'
import { NOTICE_MODULES_FILE } from './collect-notice-modules.mjs'
import { DIST, SITE_ROOT } from './lib.mjs'

const BY_NAME = ['pagefind', '@pagefind/default-ui', 'astro-expressive-code']
const BY_SCOPE = ['@expressive-code']
const MUST_LIST = ['@astrojs/starlight', 'pagefind', 'astro-expressive-code']

const HEADING = 'Third-party software shipped by the spekterm.com website'

/**
 * spek's live demo (`/spek/demo/`) is bundled by spek's build, which this site cannot see into; it
 * carries the notices of what it bundles itself, and `add-spek-demo.mjs` refuses a demo without them.
 */
export const DEMO_STATEMENT =
  "spek's live demo at /spek/demo/ is spek's own build and bundles third-party code that this file does not\n" +
  'list. The demo carries the notices of every package it bundles, with their license texts, in its\n' +
  '<script type="text/plain" id="third-party-notices"> element (view the page source).\n'

function roots() {
  if (!existsSync(NOTICE_MODULES_FILE)) throw new Error(`no shipped-module record at ${NOTICE_MODULES_FILE} — run astro build first`)
  const ids = JSON.parse(readFileSync(NOTICE_MODULES_FILE, 'utf8'))
  if (ids.length === 0) throw new Error('the shipped-module record is empty')
  const modules = join(SITE_ROOT, 'node_modules')
  const named = [
    ...BY_NAME.map((name) => join(modules, name)),
    ...BY_SCOPE.flatMap((scope) =>
      existsSync(join(modules, scope)) ? readdirSync(join(modules, scope)).map((name) => join(modules, scope, name)) : [],
    ),
  ].filter((dir) => existsSync(join(dir, 'package.json')))
  return { ids, roots: [...new Set([...packageRootsOf(ids), ...named])].sort() }
}

export function generate() {
  const { ids, roots: dirs } = roots()
  const entries = dedupeEntries(dirs.map(licenseEntryOf))
  const notices = dedupeNotices(
    ids.flatMap((id) => {
      const root = packageRootOf(id)
      if (!root) return []
      const file = id.split('?')[0]
      let source
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        return []
      }
      const where = `${root.slice(root.lastIndexOf('/node_modules/') + '/node_modules/'.length)}${file.slice(root.length)}`
      return legalCommentsOf(source).map((comment) => ({ source: where, comment }))
    }),
  )
  return { entries, text: `${renderSummary(entries, notices, HEADING)}\n\n${DEMO_STATEMENT}` }
}

function check(entries, text) {
  if (!text.includes(DEMO_STATEMENT)) throw new Error("the notices do not point to the notices spek's live demo carries")
  const names = new Set(entries.map((entry) => entry.name))
  const missing = MUST_LIST.filter((name) => !names.has(name))
  if (missing.length > 0) throw new Error(`the notices omit packages known to ship: ${missing.join(', ')}`)
  const withoutLicense = entries.filter((entry) => entry.license === 'UNKNOWN' && entry.texts.length === 0)
  if (withoutLicense.length > 0) throw new Error(`no license found for: ${withoutLicense.map((entry) => entry.name).join(', ')}`)
}

try {
  const { entries, text } = generate()
  check(entries, text)
  if (process.argv.includes('--self-test')) {
    console.log(`write-notices: self-test passed (${MUST_LIST.join(', ')} listed among ${entries.length} packages; the demo's notices pointed to)`)
  } else {
    writeFileSync(join(DIST, 'third-party-notices.txt'), text)
    console.log(`write-notices: wrote third-party-notices.txt (${entries.length} packages)`)
  }
} catch (error) {
  console.error(`write-notices: ${error.message}`)
  process.exit(1)
}
