import assert from 'node:assert/strict'
import test from 'node:test'

import { forgetInput, isTerminalReport, lastKeystrokeAt, noteWrite, onKeystroke } from './pty-input'

test('keys, pastes and replies are keystrokes', () => {
  forgetInput('s')
  noteWrite('s', '1', undefined, 10)
  assert.equal(lastKeystrokeAt('s'), 10)
  noteWrite('s', 'hello\r', undefined, 20)
  assert.equal(lastKeystrokeAt('s'), 20)
  noteWrite('s', '\x1b', undefined, 30)
  assert.equal(lastKeystrokeAt('s'), 30, 'Esc is a key')
})

test('an answer\'s own keys and the terminal\'s focus and mouse reports are not', () => {
  forgetInput('t')
  for (const report of ['\x1b[I', '\x1b[O', '\x1b[I\x1b[O', '\x1b[M !!', '\x1b[<0;12;5M', '\x1b[<0;12;5m']) {
    assert.equal(isTerminalReport(report), true, JSON.stringify(report))
    noteWrite('t', report, undefined, 5)
  }
  noteWrite('t', '1', 'answer', 5)
  assert.equal(lastKeystrokeAt('t'), null)
  // A report glued to a real key is a keystroke.
  assert.equal(isTerminalReport('\x1b[Ix'), false)
})

test('listeners hear each keystroke', () => {
  const heard: string[] = []
  const off = onKeystroke((id) => heard.push(id))
  noteWrite('u', 'k', undefined, 1)
  noteWrite('u', '\x1b[O', undefined, 2)
  off()
  noteWrite('u', 'k', undefined, 3)
  assert.deepEqual(heard, ['u'])
})
