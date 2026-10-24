/**
 * The terminal, editor and window-background literals equal the tokens they stand for (`ui-appearance`).
 *
 * xterm, Monaco and `BrowserWindow` take no CSS variables, so those modules hold literals (design D3). This is
 * what keeps them from drifting from `index.css` when a token changes — the old dark `ink-faint` lived on in
 * the editor's line numbers exactly that way.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readPalettes, readWrapperColors } from './lib/theme-tokens.mjs'

/** `[wrapper path, token]` pairs for one palette; returns the mismatches. */
function mismatches(palette, wrappers, scheme) {
  const pairs = [
    ['terminal.background', wrappers.terminal[scheme].background, 'shell'],
    ['terminal.cursorAccent', wrappers.terminal[scheme].cursorAccent, 'shell'],
    ['terminal.foreground', wrappers.terminal[scheme].foreground, 'ink-dim'],
    ['terminal.cursor', wrappers.terminal[scheme].cursor, 'accent'],
    ['editor.background', wrappers.editor[scheme]['editor.background'], 'panel'],
    ['editorGutter.background', wrappers.editor[scheme]['editorGutter.background'], 'panel'],
    ['editorLineNumber.foreground', wrappers.editor[scheme]['editorLineNumber.foreground'], 'ink-faint'],
    ['editorLineNumber.activeForeground', wrappers.editor[scheme]['editorLineNumber.activeForeground'], 'ink-dim'],
    ['editor.lineHighlightBackground', wrappers.editor[scheme]['editor.lineHighlightBackground'], 'hover'],
    ['window background', wrappers.window[scheme], 'shell'],
  ]
  return pairs
    .filter(([, literal, token]) => literal?.toLowerCase() !== palette[token]?.toLowerCase())
    .map(([where, literal, token]) => `${scheme} ${where} ${literal} ≠ --color-${token} ${palette[token]}`)
}

test('every wrapper color equals its token, in both palettes', () => {
  const palettes = readPalettes()
  const wrappers = readWrapperColors()
  assert.deepEqual([...mismatches(palettes.dark, wrappers, 'dark'), ...mismatches(palettes.light, wrappers, 'light')], [])
})

test('control: one changed value is caught', () => {
  const palettes = readPalettes()
  const wrappers = readWrapperColors()
  const drifted = { ...wrappers, editor: { ...wrappers.editor, dark: { ...wrappers.editor.dark, 'editorLineNumber.foreground': '#5b6675' } } }
  assert.deepEqual(mismatches(palettes.dark, drifted, 'dark'), [
    'dark editorLineNumber.foreground #5b6675 ≠ --color-ink-faint #6b7786',
  ])
})
