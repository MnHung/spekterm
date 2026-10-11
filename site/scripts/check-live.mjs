/**
 * project-website: The site loads nothing from another origin but Google Analytics — the served half (design D8.2), plus the
 * redirects of "spekterm.com is the canonical host".
 *
 * Run by the maintainer after a deploy and after any change to the hosting's settings: it needs a
 * deployed site, so it cannot be part of the build.
 *
 *   node scripts/check-live.mjs --commit <sha>    build that commit in a temporary worktree, then check
 *   node scripts/check-live.mjs --dist <dir>      check against an existing build of the deployed commit
 *   node scripts/check-live.mjs --self-test       run against local servers (passing and failing ones)
 *
 * Options: `--base <origin>` (default https://spekterm.com), `--redirect <origin>` (repeatable;
 * default the three redirecting hosts), `--no-redirects` (pages only — for a local server).
 *
 * For every page in the sitemap, the third-party notices, spek's live demo, and a path that does not exist, the served
 * body must equal that commit's built file byte for byte — which catches anything the hosting
 * injects, same-origin `/cdn-cgi/` scripts included — and no response may set a cookie. Each
 * redirecting host must answer a deep path with a query by a 301 to the same path and query on the
 * base.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureDir, repoRoot, sitemapPages } from './lib.mjs'

const DEFAULT_BASE = 'https://spekterm.com'
const DEFAULT_REDIRECTS = ['https://www.spekterm.com', 'https://spekterm.app', 'https://www.spekterm.app']
const DEEP = '/docs/getting-started/install/?from=live-check'

async function compare(url, expected, expectedStatus, problems) {
  let response
  try {
    response = await fetch(url, { redirect: 'manual' })
  } catch (error) {
    problems.push(`${url}: request failed (${error.message})`)
    return
  }
  if (response.status !== expectedStatus) problems.push(`${url}: status ${response.status}, expected ${expectedStatus}`)
  if (response.headers.get('set-cookie')) problems.push(`${url}: sets a cookie (${response.headers.get('set-cookie')})`)
  const body = Buffer.from(await response.arrayBuffer())
  if (!body.equals(expected)) {
    const extra = body.toString('utf8').includes('/cdn-cgi/') ? ' — it references /cdn-cgi/ (a hosting feature injected it)' : ''
    problems.push(`${url}: served body differs from the build (${body.length} vs ${expected.length} bytes)${extra}`)
  }
}

export async function checkLive({ base, dist, redirects }) {
  const problems = []
  for (const path of sitemapPages(dist)) {
    await compare(`${base}${path}`, readFileSync(join(dist, path, 'index.html')), 200, problems)
  }
  await compare(`${base}/third-party-notices.txt`, readFileSync(join(dist, 'third-party-notices.txt')), 200, problems)
  await compare(`${base}/spek/demo/`, readFileSync(join(dist, 'spek', 'demo', 'index.html')), 200, problems)
  await compare(`${base}/spekterm-live-check-no-such-page/`, readFileSync(join(dist, '404.html')), 404, problems)

  for (const origin of redirects) {
    const url = `${origin}${DEEP}`
    try {
      const response = await fetch(url, { redirect: 'manual' })
      const location = response.headers.get('location')
      if (response.status !== 301) problems.push(`${url}: status ${response.status}, expected 301`)
      if (location !== `${base}${DEEP}`) problems.push(`${url}: redirects to ${location ?? 'nothing'}, expected ${base}${DEEP}`)
      if (response.headers.get('set-cookie')) problems.push(`${url}: sets a cookie`)
    } catch (error) {
      problems.push(`${url}: request failed (${error.message})`)
    }
  }
  return problems
}

/** Builds `commit` in a temporary detached worktree (the build's root guards need git). */
function buildCommit(commit) {
  const root = repoRoot()
  const dir = mkdtempSync(join(tmpdir(), 'spekterm-live-check-'))
  rmSync(dir, { recursive: true, force: true })
  execFileSync('git', ['worktree', 'add', '--detach', dir, commit], { cwd: root, stdio: 'inherit' })
  const site = join(dir, 'site')
  execFileSync('npm', ['ci'], { cwd: site, stdio: 'inherit' })
  execFileSync('npm', ['run', 'build'], { cwd: site, stdio: 'inherit' })
  return {
    dist: join(site, 'dist'),
    cleanup: () => execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: root, stdio: 'inherit' }),
  }
}

// ---------------------------------------------------------------------------------------------
// Self-test: local servers standing in for the hosting.

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }))
  })
}

function staticHandler(dist, { inject = false, cookie = false, demoOnly = false } = {}) {
  return (req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    const file = path.endsWith('/') ? join(dist, path, 'index.html') : join(dist, path)
    const found = existsSync(file)
    let body = readFileSync(found ? file : join(dist, '404.html'))
    if (inject && file.endsWith('.html') && (!demoOnly || path === '/spek/demo/')) {
      body = Buffer.from(body.toString('utf8').replace('</body>', '<script src="/cdn-cgi/scripts/email-decode.min.js"></script></body>'))
    }
    if (cookie) res.setHeader('set-cookie', '__cf_bm=abc; path=/')
    res.writeHead(found ? 200 : 404)
    res.end(body)
  }
}

function redirectHandler(base, { status = 301, keepPath = true } = {}) {
  return (req, res) => {
    res.writeHead(status, { location: keepPath ? `${base}${req.url}` : `${base}/` })
    res.end()
  }
}

async function selfTest() {
  const page = (title) => `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`
  const dist = fixtureDir({
    'sitemap-index.xml': '<sitemapindex><sitemap><loc>https://spekterm.com/sitemap-0.xml</loc></sitemap></sitemapindex>',
    'sitemap-0.xml': '<urlset><url><loc>https://spekterm.com/</loc></url><url><loc>https://spekterm.com/docs/</loc></url></urlset>',
    'index.html': page('home'),
    'docs/index.html': page('docs'),
    '404.html': page('not found'),
    'third-party-notices.txt': 'notices\n',
    'spek/demo/index.html': page('demo'),
  })
  const servers = []
  const start = async (handler) => {
    const s = await serve(handler)
    servers.push(s.server)
    return s.origin
  }
  const misses = []
  try {
    const good = await start(staticHandler(dist))
    const goodRedirect = await start(redirectHandler(good))
    const cases = [
      { label: 'a faithful host', options: { base: good, redirects: [goodRedirect] }, expect: null },
      { label: 'an injected /cdn-cgi/ script', options: { base: await start(staticHandler(dist, { inject: true })), redirects: [] }, expect: '/cdn-cgi/' },
      { label: 'an injection into the demo alone', options: { base: await start(staticHandler(dist, { inject: true, demoOnly: true })), redirects: [] }, expect: '/spek/demo/: served body differs' },
      { label: 'a cookie', options: { base: await start(staticHandler(dist, { cookie: true })), redirects: [] }, expect: 'sets a cookie' },
      { label: 'a 302 redirect', options: { base: good, redirects: [await start(redirectHandler(good, { status: 302 }))] }, expect: 'expected 301' },
      { label: 'a redirect that drops the path', options: { base: good, redirects: [await start(redirectHandler(good, { keepPath: false }))] }, expect: 'redirects to' },
    ]
    for (const { label, options, expect } of cases) {
      const problems = await checkLive({ ...options, dist })
      if (expect === null ? problems.length > 0 : !problems.some((p) => p.includes(expect))) {
        misses.push(`${label}: ${expect === null ? `failed (${problems.join('; ')})` : `not caught (got: ${problems.join('; ') || 'none'})`}`)
      }
    }
  } finally {
    for (const server of servers) server.close()
    rmSync(dist, { recursive: true, force: true })
  }
  if (misses.length > 0) throw new Error(`self-test failed:\n  - ${misses.join('\n  - ')}`)
  console.log('check-live: self-test passed (faithful host passes; injection, demo-only injection, cookie, 302, dropped path caught)')
}

function option(name) {
  const values = []
  process.argv.forEach((arg, i) => {
    if (arg === name && process.argv[i + 1]) values.push(process.argv[i + 1])
  })
  return values
}

try {
  if (process.argv.includes('--self-test')) {
    await selfTest()
  } else {
    const base = option('--base')[0] ?? DEFAULT_BASE
    const redirects = process.argv.includes('--no-redirects')
      ? []
      : option('--redirect').length > 0
        ? option('--redirect')
        : DEFAULT_REDIRECTS
    const commit = option('--commit')[0]
    const given = option('--dist')[0]
    if (!commit && !given) throw new Error('pass --commit <deployed commit> or --dist <build of the deployed commit>')
    const built = commit ? buildCommit(commit) : { dist: given, cleanup: () => {} }
    try {
      const problems = await checkLive({ base, dist: built.dist, redirects })
      if (problems.length > 0) {
        console.error(`check-live: ${problems.length} problem(s)\n  - ${problems.join('\n  - ')}`)
        process.exitCode = 1
      } else {
        console.log(
          `check-live: ${base} serves the build unchanged and sets no cookie` +
            (redirects.length > 0 ? `; ${redirects.length} redirecting host(s) keep the path and query` : ' (redirects not checked)'),
        )
      }
    } finally {
      built.cleanup()
    }
  }
} catch (error) {
  console.error(`check-live: ${error.message}`)
  process.exitCode = 1
}
