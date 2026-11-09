import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, describe } from 'node:test'

import { MAX_REPEAT_SEARCH_YEARS } from './cron'
import { introText } from './handoff-intro'
import { prepareHandoffInjection, refreshIntros } from './handoff-injection'
import { commandsFile, configureHandoff, outboxRoot, repeatingFile, resetHandoffState } from './handoff-outbox'
import { commandRules, repeatingRules, writeHandoffRules, writeRulesFile } from './handoff-rules'
import { MAX_FIELD_LENGTH } from './intake-schema'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-rules-'))
  dirs.push(dir)
  return dir
}
function rulesOf(file: string): string {
  return JSON.parse(fs.readFileSync(file, 'utf8')).rules as string
}

/**
 * The repeating rules (`intro-layered-rules`, moved from the introduction): every rule that refuses a repeating
 * handoff has its own assertion, as the introduction's constraints do — tightening the wording keeps them green, and
 * a rule dropped from the text turns exactly its assertion red.
 */
describe('the repeating rules file', () => {
  const text = repeatingRules('Asia/Taipei')
  const cases: [string, RegExp][] = [
    ['how it is written: the outbox rules', /written into your outbox by the same rules as any handoff \(a new file name ending in \.json, written atomically\)/],
    ['the shape with repeat, at and until', /"repeat": "<cron>", "at": "<optional start>", "until": "<optional end>"/],
    ['the five cron fields, in the desktop zone', /repeat: cron "minute hour day month weekday" in Asia\/Taipei/],
    ['at is the start, until the end, both optional', /"at" is its start and "until" its end, both optional/],
    ['until has the format of at and no day bound', /"until" has the format of "at" and no day bound/],
    ['the field syntax', /\* or a list of n, a-b, \*\/s, a-b\/s; JAN-DEC, SUN-SAT; weekday 0 or 7 is Sunday/],
    ['day and weekday both set: either matches', /day and weekday both set: either matches/],
    ['what is refused, with its code', /Rejected \(receipt "rejected", code REPEAT_INVALID\): a minute that is not one number, seconds, @macros, L W # \?/],
    ['until without repeat is refused', /"until" without "repeat"/],
    ['until not after now and the start, or with no time before it', /"until" not after now and the start, or with no time before it/],
    ['the user approves it first', /The user approves it first \(receipt "proposed"/],
    ['each time opens a new session until it ends or is stopped', /each time opens a new session until it ends or is stopped/],
    ['missed times run once at the next start', /times missed while spekterm was closed run once at the next start/],
  ]
  for (const [label, pattern] of cases) test(label, () => assert.match(text, pattern))

  test('the stated year bound is the one the schedule search applies', () => {
    assert.equal(Number(/no time in (\d+) years/.exec(text)?.[1]), MAX_REPEAT_SEARCH_YEARS)
  })

  test('the zone is the desktop zone when none is passed', () => {
    assert.ok(repeatingRules().includes(` in ${Intl.DateTimeFormat().resolvedOptions().timeZone},`))
  })
})

describe('the commands rules file', () => {
  const text = commandRules()
  const cases: [string, RegExp][] = [
    ['how it is written: the outbox rules', /written into your outbox by the same rules as a handoff/],
    ['the four shapes', /\{"kind": "close"\}, \{"kind": "hibernate"\}, \{"kind": "rename", "name": "<new label>"\} or \{"kind": "wake", "target": "<name>"\}/],
    ['no target means your own session', /With no "target" a command acts on your own session/],
    ['close, hibernate and rename reach only the children tree; wake also the parent and siblings', /close, hibernate and rename only one in your "children" tree; wake also your parent and siblings/],
    ['an unknown name and any other session are refused, with their codes', /CONTROL_TARGET_NOT_FOUND.*CONTROL_NOT_ALLOWED/],
    ['hibernate keeps the session; wake at once without asking', /Hibernate ends its process but keeps it, dormant\. Wake starts a dormant one at once, without asking the user/],
    ['the end-of-turn rule', /wait for the target's turn to end/],
    ['typing into the target drops it', /dropped if the user types into it first/],
    ['events are needed for a running target', /of a running target need agent event reporting on; with it off they are refused \(CONTROL_UNAVAILABLE\)/],
    ['closing your own session is only offered', /Closing your own session only offers the user to close or keep it/],
    ['rename: one line', /on one\s+line/],
    ['rename: an empty name gives naming back', /empty name gives naming back/],
    ['rename: no messaging name changes', /No name used for messaging changes/],
    ['a woken session can be messaged once running and listed', /once your relations file shows it "running": true and its name shows in ListAgents/],
    ['do not wake a parent only to report', /Do not wake a parent only to report: a report needs no running parent/],
    ['a wake that did not take is not repeated without asking', /ask the user before waking it again/],
    ['there is no reply: the receipt says accepted, the relations file shows the result', /A receipt says a command was accepted, not that it was carried out\. Your relations file shows the result/],
  ]
  for (const [label, pattern] of cases) test(label, () => assert.match(text, pattern))

  test('the name limit it states is the one applied', () => {
    assert.ok(text.includes(`"name" is at most ${MAX_FIELD_LENGTH} characters`))
  })
})

describe('writing the rules files', () => {
  test('both sit at the handoff root, outside every outbox, and are the ones the introduction names', () => {
    const base = tmp()
    resetHandoffState()
    configureHandoff(base)
    writeHandoffRules('Asia/Taipei')
    for (const file of [repeatingFile(), commandsFile()]) {
      assert.ok(fs.existsSync(file), file)
      const rel = path.relative(outboxRoot(), file)
      assert.ok(rel.startsWith('..'), `${file} is inside the outbox root`)
    }
    assert.equal(rulesOf(commandsFile()), commandRules())
    assert.equal(rulesOf(repeatingFile()), repeatingRules('Asia/Taipei'))
    // The default locations the introduction derives from an outbox are these files.
    const text = introText({ folders: [], outbox: path.join(outboxRoot(), 's1') })
    assert.ok(text.includes(repeatingFile()) && text.includes(commandsFile()))
  })

  test('every intro write point writes them, and a deleted one comes back', () => {
    const base = tmp()
    resetHandoffState()
    configureHandoff(base)
    assert.ok(prepareHandoffInjection('s1', []))
    assert.ok(fs.existsSync(repeatingFile()) && fs.existsSync(commandsFile()))
    fs.rmSync(commandsFile())
    refreshIntros(['s1'], [], () => undefined)
    assert.ok(fs.existsSync(commandsFile()))
  })

  test('an unchanged file is not rewritten, a changed one is', () => {
    const file = path.join(tmp(), 'commands.json')
    writeRulesFile(file, 'one')
    const first = fs.statSync(file).mtimeMs
    fs.utimesSync(file, new Date(0), new Date(0))
    writeRulesFile(file, 'one')
    assert.equal(fs.statSync(file).mtimeMs, 0, 'same content: not rewritten')
    writeRulesFile(file, 'two')
    assert.equal(rulesOf(file), 'two')
    assert.ok(first > 0)
  })

  test('a file that cannot be written does not throw', () => {
    const blocker = path.join(tmp(), 'not-a-dir')
    fs.writeFileSync(blocker, '')
    assert.doesNotThrow(() => writeRulesFile(path.join(blocker, 'commands.json'), 'x'))
    assert.doesNotThrow(() => writeRulesFile('', 'x'))
  })
})
