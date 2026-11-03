/**
 * `probe:team`'s control groups (`team-membership`): undo a fix, and confirm the named assertion turns red.
 *
 * Each mutation first proves it changed something (an unchanged file is a control group that cannot fail), and the
 * build runs on every round, so each round tests the code that ships. `command: 'test'` runs the unit tests instead
 * of the probe, for a property only they can carry.
 *
 * Usage: `node scripts/team-control-groups.mjs [name…]`
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export const MUTATIONS = [
  {
    name: 'pin-checked-after-data',
    file: 'src/main/team-connection.ts',
    // The upgrade is sent, and the connection refused only once it was flushed: the order an \`upgrade\`-time check has.
    // (A write followed at once by \`destroy()\` is discarded before it is flushed, so it cannot tell — measured.)
    from: `          fail(Object.assign(new Error('the server certificate does not match the pinned fingerprint'), { pinMismatch: true }))`,
    to: `          socket.write('GET /connect HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n', () =>
            fail(Object.assign(new Error('the server certificate does not match the pinned fingerprint'), { pinMismatch: true })),
          )`,
    section: 'runPinMismatch',
    expectRed: 'no application data reached the server',
    why: 'Data written before the pin is compared: the shape a check in `ws`\'s `upgrade` event would have.',
  },
  {
    name: 'replaced-retried',
    file: 'src/main/team-outcome.ts',
    from: `    case 4006:
      return { kind: 'stop', reason: 'REPLACED' }`,
    to: `    case 4006:
      return { kind: 'retry', reason: 'SERVER_CLOSED' }`,
    section: 'runReplacedAndVersion',
    expectRed: 'a replaced connection stops',
    why: 'Two holders of one credential reconnecting on 4006 replace each other forever.',
  },
  {
    name: 'leave-uses-hello-count',
    file: 'src/main/team-service.ts',
    from: `    const list = await this.refreshMembers({ force: true })`,
    to: `    const list = null as TeamMember[] | null
    void this.refreshMembers({ force: true })`,
    section: 'runLeave',
    expectRed: 'leaving with 2 device(s) says only this device leaves',
    why: 'The confirmation read without a fresh members list: the dangerous direction says "only this device" wrongly.',
  },
  {
    name: 'generation-check-removed',
    file: 'src/main/team-service.ts',
    from: `  #onEnd(end: ConnectionEnd, generation: number): void {
    if (generation !== this.#generation) return`,
    to: `  #onEnd(end: ConnectionEnd, generation: number): void {`,
    command: 'test',
    testFile: 'src/main/team-service.test.ts',
    expectRed: 'an abandoned connection’s late close does not disturb the next one',
    why: 'A late close of a connection spekterm gave up on starts a third connection (the server then sends 4006).',
  },
  {
    name: 'hello-without-secret',
    file: 'src/main/team-service.ts',
    // The failure the rule exists for: a missing secret taken for a revocation. (Removing only the check at start
    // cannot tell: \`#settle\` and \`#connect\` each refuse to send a \`hello\` without a secret too — measured.)
    from: `      this.#enterStop('CREDENTIAL_UNAVAILABLE', { persist: false, notify: false })
      return
    }
    const stop = state.stop`,
    to: `      this.#discard('REVOKED', true)
      return
    }
    const stop = state.stop`,
    section: 'runMissingSecret',
    expectRed: 'a membership without its secret stops, keeping the membership',
    why: 'A membership without its secret taken for a revocation: the user is told they left a team they are still on.',
  },
]

function run(names) {
  const selected = names.length > 0 ? MUTATIONS.filter((m) => names.includes(m.name)) : MUTATIONS
  if (selected.length === 0) {
    console.error(`unknown name; available: ${MUTATIONS.map((m) => m.name).join(', ')}`)
    process.exit(1)
  }
  const failures = []
  for (const mutation of selected) {
    const full = join(repoRoot, mutation.file)
    const original = readFileSync(full, 'utf8')
    if (!original.includes(mutation.from)) {
      failures.push(`${mutation.name}: the fragment to replace is not in the source`)
      continue
    }
    const mutated = original.replace(mutation.from, mutation.to)
    if (mutated === original) {
      failures.push(`${mutation.name}: the replacement changed nothing`)
      continue
    }
    console.log(`\n── ${mutation.name} ──\n${mutation.why}\nexpected red: ${mutation.expectRed}`)
    writeFileSync(full, mutated)
    let output
    try {
      // A unit-test control runs its one file: the whole suite's output overflows the default buffer, and a
      // truncated output cannot show the red line (measured: the first run reported "not red").
      const [command, args] =
        mutation.command === 'test' ? [process.execPath, ['--import', 'tsx', '--test', mutation.testFile]] : ['npm', ['run', 'probe:team']]
      output = execFileSync(command, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...(mutation.section ? { PROBE_ONLY: mutation.section } : {}) },
      })
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    } finally {
      writeFileSync(full, original)
    }
    // A node:test red is matched on its whole line: passing subtests print their names too.
    const notOkLine = new RegExp(`^\\s*not ok \\d+ - ${mutation.expectRed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm')
    const wentRed = output.includes(`✗ ${mutation.expectRed}`) || (mutation.command === 'test' && notOkLine.test(output))
    console.log(wentRed ? '  ✓ red as expected' : '  ✗ **not red** — that assertion cannot tell')
    if (!wentRed) failures.push(`${mutation.name}: ${mutation.expectRed} did not turn red`)
  }
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' })
  if (failures.length > 0) {
    console.error(`\n${failures.length} control group(s) failed:`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(`\nall ${selected.length} control groups turned red as expected.`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
}
