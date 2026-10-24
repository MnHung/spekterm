/**
 * The two palettes of `src/renderer/src/index.css` and the wrapper literals that stand for them
 * (`ui-appearance`), read from source for `theme-contrast.test.mjs` and `theme-palette.test.mjs`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8')

/** `--color-*: value;` declarations of a CSS block, as `{ name: value }` (name without `--color-`). */
function colorDeclarations(block) {
  const tokens = {}
  for (const match of block.matchAll(/--color-([a-z-]+):\s*([^;]+);/g)) tokens[match[1]] = match[2].trim()
  return tokens
}

/** The block that follows `opener` up to its matching closing brace. */
function blockAfter(source, opener) {
  const start = source.indexOf(opener)
  if (start < 0) throw new Error(`not found: ${opener}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (const [offset, char] of [...source.slice(open)].entries()) {
    if (char === '{') depth++
    else if (char === '}' && --depth === 0) return source.slice(start, open + offset + 1)
  }
  throw new Error(`unclosed: ${opener}`)
}

/** `{ dark, light }`: dark from `@theme`, light from the `prefers-color-scheme: light` block. */
export function palettesFrom(css) {
  return {
    dark: colorDeclarations(blockAfter(css, '@theme {')),
    light: colorDeclarations(blockAfter(css, '@media (prefers-color-scheme: light)')),
  }
}

export function readPalettes() {
  return palettesFrom(read('src/renderer/src/index.css'))
}

/** `key: '#hex'` pairs inside the object literal named `name` in `source` (one level of nesting per palette). */
export function literalObject(source, name) {
  const block = blockAfter(source, name)
  const result = {}
  for (const palette of ['dark', 'light']) {
    const inner = blockAfter(block, `${palette}: {`)
    result[palette] = {}
    for (const match of inner.matchAll(/'?([\w.]+)'?:\s*'(#[0-9a-fA-F]{6})'/g)) result[palette][match[1]] = match[2]
  }
  return result
}

export function readWrapperColors() {
  return {
    terminal: literalObject(read('src/renderer/src/shell/terminal/xterm.ts'), 'export const TERMINAL_THEMES'),
    editor: literalObject(read('src/renderer/src/editor/index.tsx'), 'export const EDITOR_COLORS'),
    window: windowBackgroundFrom(read('src/main/appearance.ts')),
  }
}

export function windowBackgroundFrom(source) {
  const match = source.match(/WINDOW_BACKGROUND = \{ dark: '(#[0-9a-fA-F]{6})', light: '(#[0-9a-fA-F]{6})' \}/)
  if (!match) throw new Error('WINDOW_BACKGROUND not found')
  return { dark: match[1], light: match[2] }
}

/** WCAG 2 contrast ratio of two `#rrggbb` colors. */
export function contrast(a, b) {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
