/**
 * Both palettes keep text readable on every surface they are drawn on (`ui-appearance`, "Each palette meets the
 * contrast floor"), and the light terminal's 16 ANSI colors stay readable on its background.
 *
 * A light value can pass and still look wrong (hover too close to its surface): this bounds text only; the look
 * is judged by dogfood.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { contrast, literalObject, readPalettes, repoRoot } from './lib/theme-tokens.mjs'

const SURFACES = ['shell', 'rail', 'stage', 'panel', 'hover']
const FLOORS = { ink: 4.5, 'ink-dim': 4.5, 'ink-faint': 3, accent: 3, danger: 3, blue: 3, green: 3 }

/** Every (text, surface) pair under its floor, as readable strings. */
function failures(palette) {
  const found = []
  for (const [text, floor] of Object.entries(FLOORS)) {
    for (const surface of SURFACES) {
      const ratio = contrast(palette[text], palette[surface])
      if (ratio < floor) found.push(`${text} on ${surface}: ${ratio.toFixed(2)} < ${floor}`)
    }
  }
  return found
}

const ANSI = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
]

test('both palettes declare every color the floors name', () => {
  const palettes = readPalettes()
  for (const name of ['dark', 'light']) {
    for (const token of [...SURFACES, ...Object.keys(FLOORS)]) {
      assert.match(palettes[name][token] ?? '', /^#[0-9a-f]{6}$/i, `${name} ${token}`)
    }
  }
})

test('each palette meets the contrast floor on each of its surfaces', () => {
  const palettes = readPalettes()
  assert.deepEqual(failures(palettes.dark), [], 'dark')
  assert.deepEqual(failures(palettes.light), [], 'light')
})

test('control: the dark accent in the light palette, and the old dark faint text, fail', () => {
  const palettes = readPalettes()
  assert.ok(failures({ ...palettes.light, accent: palettes.dark.accent }).some((f) => f.startsWith('accent')))
  assert.ok(failures({ ...palettes.dark, 'ink-faint': '#5b6675' }).some((f) => f === 'ink-faint on hover: 2.81 < 3'))
})

test("the light terminal's 16 ANSI colors are each at least 3:1 on its background", () => {
  const source = readFileSync(join(repoRoot, 'src/renderer/src/shell/terminal/xterm.ts'), 'utf8')
  const light = literalObject(source, 'export const TERMINAL_THEMES').light
  const low = ANSI.filter((name) => !light[name] || contrast(light[name], light.background) < 3)
  assert.deepEqual(low, [], `missing or under 3:1: ${low.map((n) => `${n} ${light[n]}`).join(', ')}`)
  // Control: xterm's default bright yellow (made for dark) fails on the light background.
  assert.ok(contrast('#ffff00', light.background) < 3)
})
