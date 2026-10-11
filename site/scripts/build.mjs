/**
 * The site's build — and therefore the gate to publishing (project-website: The site's build is the
 * gate to publishing; design D12). The hosting runs this script; a page that fails any step never
 * deploys.
 *
 * Each check runs its `--self-test` first, so a check that has gone blind stops the build instead of
 * passing it. A root unit test (`scripts/site-boundary.test.mjs`) asserts that every step below is
 * still invoked here — keep the `step('<name>', ...)` literals.
 *
 * `--structure-only` skips check-content's content part (pages still being written). It is a
 * development convenience; the deploy runs the full build.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { SITE_ROOT } from './lib.mjs'

const structureOnly = process.argv.includes('--structure-only')
// Astro's CLI reports anonymous usage by default; the site's build has no reason to.
const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }
const astro = join(SITE_ROOT, 'node_modules', '.bin', 'astro')

function exec(command, args) {
  const result = spawnSync(command, args, { cwd: SITE_ROOT, env, stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status === 0
}

function step(name, ...commands) {
  console.log(`\n▶ ${name}`)
  for (const [command, args] of commands) {
    if (!exec(command, args)) {
      console.error(`\n✗ build stopped: "${name}" failed`)
      process.exit(1)
    }
  }
}

const node = (script, ...args) => [process.execPath, [join('scripts', script), ...args]]
const checked = (script, ...args) => [node(script, '--self-test'), node(script, ...args)]

step('astro check', [astro, ['check']])
step('root content guards', [process.execPath, ['--test', '--test-reporter=dot', '../scripts/public-hygiene.test.mjs', '../scripts/license.test.mjs']])
step('astro build', [astro, ['build']])
step('spek demo', ...checked('add-spek-demo.mjs'))
step('parity', ...checked('check-parity.mjs'))
step('origins', ...checked('check-origins.mjs'))
step('notices', ...checked('write-notices.mjs'))
step('content', ...checked('check-content.mjs', ...(structureOnly ? ['--structural-only'] : [])))

console.log(structureOnly ? '\n✓ site built (content part of check-content skipped)' : '\n✓ site built and checked')
