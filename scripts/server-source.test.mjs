/**
 * remote-access / spek-core-integration: **only the remote access listener creates a server** in the main
 * process.
 *
 * This was a check inside `probe:core` ("the main process creates no server"): a text match over `src/main`,
 * comments included. With `mobile-remote-bridge` one module may create one — `src/main/remote-server.ts`,
 * which listens only while the user has turned remote access on — so the rule became "only there", and as a
 * rule about source it belongs here, not in a run. `probe:core` keeps its runtime half: with a fresh
 * profile no process of the app holds a LISTEN socket.
 *
 * **Comments count**, as they did: the match is plain text, so a comment that spells out the two server
 * calls in another file fails it too (`agent-wait.ts` documents that trap). Test files are excluded — they
 * start throwaway servers on purpose.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = join(repoRoot, 'src', 'main')
const ALLOWED = 'src/main/remote-server.ts'
const SERVER = /createServer|\.listen\(/

function mainSources() {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      return entry.name.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(entry.name) ? [full] : []
    })
  return walk(MAIN).map((full) => ({ file: relative(repoRoot, full), text: readFileSync(full, 'utf8') }))
}

export function serverOffenders(sources, allowed = ALLOWED) {
  return sources.filter(({ file, text }) => file !== allowed && SERVER.test(text)).map(({ file }) => file)
}

test('only the remote access listener creates a server in src/main', () => {
  const sources = mainSources()
  assert.ok(sources.length > 50, `the scan reached only ${sources.length} files`)
  assert.ok(SERVER.test(sources.find(({ file }) => file === ALLOWED)?.text ?? ''), 'the listener itself is found')
  assert.deepEqual(serverOffenders(sources), [])
})

test('control: a server anywhere else is reported, a comment included', () => {
  assert.deepEqual(
    serverOffenders([
      { file: 'src/main/other.ts', text: `import { createServer } from 'node:net'` },
      { file: 'src/main/commented.ts', text: `// we never call server.listen( here` },
      { file: ALLOWED, text: `server.listen(port)` },
      { file: 'src/main/clean.ts', text: `const listeners = new Set()` },
    ]),
    ['src/main/other.ts', 'src/main/commented.ts'],
  )
})
