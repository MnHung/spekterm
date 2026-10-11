/**
 * project-website: "The site is built from the repository and stays out of the app".
 *
 * The website lives in `site/` with its own package and lockfile. Nothing from it may reach the desktop
 * artifact, and the root project must not adopt it as a workspace — a workspace would hoist the site's
 * dependencies into the root install and its lockfile. (Root and site sharing some packages, such as
 * `typescript`, is not a leak.)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, matchesGlob } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const rootLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))

/** Paths that stand for "something under the site's directory". */
const SITE_SAMPLES = ['site/package.json', 'site/dist/index.html', 'site/src/content/docs/index.mdx']

/** Does one packaging selection (a pattern string, or `{ from, filter }`) select a path under `site/`? */
function selectsSite(selection) {
  const from = typeof selection === 'string' ? selection : selection?.from
  if (typeof from !== 'string' || from.startsWith('!')) return false
  if (from === 'site' || from.startsWith('site/')) return true
  return SITE_SAMPLES.some((sample) => matchesGlob(sample, from))
}

/**
 * The packaging configuration's file selections — included files, extra files, extra resources — at the top
 * level and in every platform's section. electron-builder adds a platform's selections to the top-level
 * ones, so a selection under `build.mac` reaches the macOS artifact as surely as a top-level one.
 */
function packagingSelections(build) {
  const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])
  const of = (section) => [
    ...asList(section?.files),
    ...asList(section?.extraFiles),
    ...asList(section?.extraResources),
  ]
  return [...of(build), ...of(build.linux), ...of(build.mac), ...of(build.win)]
}

test('the packaging configuration selects nothing under site/', () => {
  const offending = packagingSelections(rootPackage.build).filter(selectsSite)
  assert.deepEqual(offending, [], `packaging selects the website: ${JSON.stringify(offending)}`)
})

test('control: a selection of site/** in a platform section is caught', () => {
  for (const platform of ['linux', 'mac', 'win']) {
    const build = {
      ...rootPackage.build,
      [platform]: { ...rootPackage.build[platform], extraResources: [{ from: 'site/dist', to: 'docs' }] },
    }
    assert.ok(packagingSelections(build).some(selectsSite), `not caught under build.${platform}`)
  }
})

test('control: a selection of site/** is caught', () => {
  for (const mutation of ['site/**', 'site', '**/*.mdx', { from: 'site/dist', to: 'docs' }]) {
    const build = { ...rootPackage.build, files: [...rootPackage.build.files, mutation] }
    assert.ok(packagingSelections(build).some(selectsSite), `not caught: ${JSON.stringify(mutation)}`)
  }
})

/** What in the root package and lockfile adopts the site: workspaces, and lock entries under `site/`. */
function adoptionOf(pkg, lock) {
  const siteEntries = Object.keys(lock.packages ?? {}).filter((key) => key === 'site' || key.startsWith('site/'))
  return { workspaces: pkg.workspaces ?? null, siteEntries }
}

test('the root project does not adopt the site as a workspace or list it in its lockfile', () => {
  assert.deepEqual(adoptionOf(rootPackage, rootLock), { workspaces: null, siteEntries: [] })
})

test('control: a workspace and its lock entries are caught', () => {
  const pkg = { ...rootPackage, workspaces: ['site'] }
  const lock = { packages: { ...rootLock.packages, site: { name: 'spekterm-site' }, 'site/node_modules/astro': {} } }
  assert.deepEqual(adoptionOf(pkg, lock), { workspaces: ['site'], siteEntries: ['site', 'site/node_modules/astro'] })
})

// project-website: "The site's build is the gate to publishing". The hosting runs the site's `build`
// script; these are the steps it must still run, in order. A step deleted from `build.mjs` (or a
// `build` script that bypasses it) would let a failing page publish, with nothing turning red.

const SITE_BUILD_STEPS = ['astro check', 'root content guards', 'astro build', 'spek demo', 'parity', 'origins', 'notices', 'content']

/** The step names a build script declares, in order (`step('<name>', …)`). */
function stepsOf(source) {
  return [...source.matchAll(/^step\('([^']+)'/gm)].map((match) => match[1])
}

test("the site's build runs every gate step, in order", () => {
  const sitePackage = JSON.parse(readFileSync(join(repoRoot, 'site', 'package.json'), 'utf8'))
  assert.equal(sitePackage.scripts.build, 'node scripts/build.mjs')
  const source = readFileSync(join(repoRoot, 'site', 'scripts', 'build.mjs'), 'utf8')
  assert.deepEqual(stepsOf(source), SITE_BUILD_STEPS)
  assert.match(source, /public-hygiene\.test\.mjs/)
  assert.match(source, /license\.test\.mjs/)
})

test('control: a deleted build step is caught', () => {
  const source = SITE_BUILD_STEPS.map((name) => `step('${name}', x)`).join('\n')
  assert.deepEqual(stepsOf(source), SITE_BUILD_STEPS)
  assert.notDeepEqual(stepsOf(source.replace("step('origins', x)\n", '')), SITE_BUILD_STEPS)
})

// project-website: "The documentation is the user guide" and "Nothing says Linux only" (README half).
// The READMEs link to the docs and keep what desktop-packaging reads them for — which gives that spec's
// two README scenarios ("README 記載執行前提與逃生口", "README 記載安裝與移除") their first carrier.

const README_NETWORK = { 'README.md': /network/i, 'README.zh-TW.md': /網路/ }

/** Problems with one README's text. */
function readmeProblems(name, text, forbiddenPhrases) {
  const problems = []
  if (!text.includes('https://spekterm.com/docs/')) problems.push(`${name}: no link to https://spekterm.com/docs/`)
  const lower = text.toLowerCase()
  const flat = lower.replace(/\s+/g, ' ')
  for (const phrase of forbiddenPhrases) if (flat.includes(phrase.toLowerCase().replace(/\s+/g, ' '))) problems.push(`${name}: says "${phrase}"`)
  const lines = text.split('\n')
  const fuse = lines.findIndex((line) => line.includes('libfuse2'))
  const hatch = lines.findIndex((line) => line.includes('--appimage-extract-and-run'))
  if (fuse === -1) problems.push(`${name}: no libfuse2 requirement`)
  if (hatch === -1) problems.push(`${name}: no --appimage-extract-and-run escape hatch`)
  if (fuse !== -1 && hatch !== -1 && Math.abs(fuse - hatch) > 6) {
    problems.push(`${name}: the escape hatch is not next to the libfuse2 requirement (lines ${fuse + 1} and ${hatch + 1})`)
  }
  const packaging = lines.findIndex((line) => line.includes('electron-builder'))
  const window = packaging === -1 ? '' : lines.slice(Math.max(0, packaging - 10), packaging + 10).join('\n')
  if (!README_NETWORK[name].test(window)) problems.push(`${name}: the first packaging's network need is not stated next to it`)
  for (const command of ['npm run install:desktop', 'npm run uninstall:desktop']) {
    if (!text.includes(command)) problems.push(`${name}: no ${command}`)
  }
  return problems
}

test('the READMEs link to the docs, never say Linux only, and keep the install facts', () => {
  const plan = JSON.parse(readFileSync(join(repoRoot, 'site', 'src', 'content-plan.json'), 'utf8'))
  const problems = Object.keys(README_NETWORK).flatMap((name) =>
    readmeProblems(name, readFileSync(join(repoRoot, name), 'utf8'), plan.forbiddenPhrases),
  )
  assert.deepEqual(problems, [])
})

test('control: README problems are caught', () => {
  const good = [
    'See https://spekterm.com/docs/.',
    'Needs libfuse2.',
    'Without it: --appimage-extract-and-run',
    'The first packaging downloads Electron and needs network access.',
    'npm run build && npx electron-builder --linux',
    'npm run install:desktop / npm run uninstall:desktop',
  ].join('\n')
  assert.deepEqual(readmeProblems('README.md', good, ['Linux only']), [])
  assert.match(readmeProblems('README.md', `${good}\nLinux Only for now`, ['Linux only']).join(), /Linux only/)
  assert.match(readmeProblems('README.md', good.replace('https://spekterm.com/docs/', ''), []).join(), /no link/)
  assert.match(readmeProblems('README.md', good.replace('needs network access', 'is slow'), []).join(), /network need/)
  assert.match(readmeProblems('README.md', `${good.replace('Without it: --appimage-extract-and-run\n', '')}\n\n\n\n\n\n\n\n--appimage-extract-and-run`, []).join(), /not next to/)
})
