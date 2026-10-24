import assert from 'node:assert/strict'
import test from 'node:test'

import { createWheelZoom, zoomKeyDirection, type ZoomKey } from './zoom-input'

const key = (over: Partial<ZoomKey>): ZoomKey => ({
  key: '',
  code: '',
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
})

test('Ctrl with =, + and 0 zoom in and reset, Shift allowed', () => {
  assert.equal(zoomKeyDirection(key({ key: '=' }), false), 1)
  assert.equal(zoomKeyDirection(key({ key: '+', shiftKey: true }), false), 1)
  assert.equal(zoomKeyDirection(key({ key: '0' }), false), 0)
  assert.equal(zoomKeyDirection(key({ key: '0', shiftKey: true }), false), 0)
})

test('Ctrl+- zooms out; Ctrl+Shift+- is ^_ and does not zoom', () => {
  // Control: drop the `!shiftKey` and the second assertion goes red.
  assert.equal(zoomKeyDirection(key({ key: '-' }), false), -1)
  assert.equal(zoomKeyDirection(key({ key: '_', shiftKey: true }), false), null)
  assert.equal(zoomKeyDirection(key({ key: '-', shiftKey: true }), false), null)
})

test('the keypad by code', () => {
  assert.equal(zoomKeyDirection(key({ code: 'NumpadAdd', key: '+' }), false), 1)
  assert.equal(zoomKeyDirection(key({ code: 'NumpadSubtract', key: '-' }), false), -1)
  assert.equal(zoomKeyDirection(key({ code: 'Numpad0', key: 'Insert' }), false), 0)
})

test('Alt never zooms; Cmd takes the place of Ctrl on macOS only', () => {
  assert.equal(zoomKeyDirection(key({ key: '=', altKey: true }), false), null)
  assert.equal(zoomKeyDirection(key({ key: '=', ctrlKey: false, metaKey: true }), false), null)
  assert.equal(zoomKeyDirection(key({ key: '=', ctrlKey: false, metaKey: true }), true), 1)
  assert.equal(zoomKeyDirection(key({ key: '=' }), true), null)
  assert.equal(zoomKeyDirection(key({ key: '=', ctrlKey: false }), false), null)
  assert.equal(zoomKeyDirection(key({ key: 'a' }), false), null)
})

test('a notch is one step at every zoom; wheel up zooms in', () => {
  const wheel = createWheelZoom()
  assert.equal(wheel({ deltaY: -120, deltaMode: 0, timeStamp: 0 }, 100), 1)
  // At 150% the same notch arrives as -80 CSS px: still 120 device px.
  assert.equal(wheel({ deltaY: -80, deltaMode: 0, timeStamp: 1000 }, 150), 1)
  assert.equal(wheel({ deltaY: 240, deltaMode: 0, timeStamp: 2000 }, 50), -1)
  assert.equal(wheel({ deltaY: 3, deltaMode: 1, timeStamp: 3000 }, 100), -1)
  // 60 CSS px at 50% is 30 device px: a touchpad movement, not a notch. Control: drop the zoom factor → a step.
  assert.equal(wheel({ deltaY: -60, deltaMode: 0, timeStamp: 4000 }, 50), null)
})

test('small movements add up to one step, and a pause drops a partial sum', () => {
  const wheel = createWheelZoom()
  const steps = [0, 1, 2, 3, 4].map((i) => wheel({ deltaY: -25, deltaMode: 0, timeStamp: i * 10 }, 100))
  assert.deepEqual(steps, [null, null, null, 1, null], 'four small events of 25 px are one notch')
  const after = createWheelZoom()
  assert.equal(after({ deltaY: -30, deltaMode: 0, timeStamp: 0 }, 100), null)
  assert.equal(after({ deltaY: -30, deltaMode: 0, timeStamp: 1000 }, 100), null)
  assert.equal(after({ deltaY: -30, deltaMode: 0, timeStamp: 1010 }, 100), null)
  assert.equal(after({ deltaY: -30, deltaMode: 0, timeStamp: 1020 }, 100), null, 'the first 30 was dropped')
  assert.equal(after({ deltaY: -30, deltaMode: 0, timeStamp: 1030 }, 100), 1)
})
