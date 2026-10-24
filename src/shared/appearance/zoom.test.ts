import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ZOOM, isTheme, snapZoom, stepZoom, ZOOM_STEPS } from './zoom'

test('steps run from 50 to 175 with 100 among them', () => {
  assert.equal(ZOOM_STEPS[0], 50)
  assert.equal(ZOOM_STEPS[ZOOM_STEPS.length - 1], 175)
  assert.ok((ZOOM_STEPS as readonly number[]).includes(DEFAULT_ZOOM))
})

test('an off-step value snaps to the nearest step, the smaller on a tie', () => {
  assert.equal(snapZoom(100), 100)
  assert.equal(snapZoom(104), 100)
  assert.equal(snapZoom(106), 110)
  // Halfway between 100 and 110. Control: `<=` in the comparison picks 110.
  assert.equal(snapZoom(105), 100)
  assert.equal(snapZoom(137.5), 125)
  assert.equal(snapZoom(10), 50)
  assert.equal(snapZoom(400), 175)
})

test('a non-number is no zoom', () => {
  assert.equal(snapZoom('125'), undefined)
  assert.equal(snapZoom(Number.NaN), undefined)
  assert.equal(snapZoom(Number.POSITIVE_INFINITY), undefined)
  assert.equal(snapZoom(null), undefined)
})

test('stepping moves one step and stops at the ends', () => {
  assert.equal(stepZoom(100, 1), 110)
  assert.equal(stepZoom(100, -1), 90)
  assert.equal(stepZoom(undefined, 1), 110)
  assert.equal(stepZoom(175, 1), 175)
  assert.equal(stepZoom(50, -1), 50)
  assert.equal(stepZoom(150, 0), 100)
  assert.equal(stepZoom(104, 1), 110)
})

test('only the three theme values are themes', () => {
  assert.ok(isTheme('system') && isTheme('light') && isTheme('dark'))
  assert.ok(!isTheme('Dark') && !isTheme('auto') && !isTheme(undefined))
})
