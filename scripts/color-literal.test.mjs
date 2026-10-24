/**
 * No color literal or palette color class in the renderer outside the files allowed to hold them
 * (`ui-appearance`). A literal or `bg-emerald-400` does not follow the theme: in Light it stays the dark
 * palette's color, and nothing turns red. Colors go through the tokens of `index.css`.
 *
 * Allowed: `index.css` (it is not scanned — it defines the tokens), the terminal and editor wrappers (their
 * literals are held to the tokens by `theme-palette.test.mjs`), and the remote pairing QR code, which stays
 * black on white in both themes because a scanner needs it.
 *
 * Scans string and template literals through the syntax tree, so comments ("issue #100") are not literals.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { repoRoot } from './lib/theme-tokens.mjs'

const ALLOWED_FILES = new Set([
  'src/renderer/src/shell/terminal/xterm.ts',
  'src/renderer/src/editor/index.tsx',
])

/** The QR code's two values, allowed in its file only. */
const QR = { file: 'src/renderer/src/shell/settings/sections/RemoteSection.tsx', values: ['bg-white', '#000'] }

const HEX = /#[0-9a-fA-F]{3,8}\b/
const RGB = /(?<![a-zA-Z])(?:rgba?|hsla?)\(/
const PALETTE_CLASS =
  /(?:^|[\s:"'`[])(?:bg|text|border|ring|shadow|fill|stroke|from|to|via|outline|divide|placeholder|caret|decoration|accent)-(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/

/** `{ line, text, match }` of every literal holding a color. */
export function findColorLiterals(source, fileName = 'sample.tsx') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found = []
  const visit = (node) => {
    const isLiteral =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    if (isLiteral) {
      const match = node.text.match(HEX) ?? node.text.match(RGB) ?? node.text.match(PALETTE_CLASS)
      if (match) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        found.push({ line: line + 1, text: node.text, match: match[0].trim().replace(/^[:"'`[]/, '') })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function rendererSources(dir = join(repoRoot, 'src', 'renderer', 'src')) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...rendererSources(path))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path)
  }
  return files
}

test('the renderer holds no color literal outside the allowed files', () => {
  const offenders = []
  for (const path of rendererSources()) {
    const file = relative(repoRoot, path)
    if (ALLOWED_FILES.has(file)) continue
    for (const hit of findColorLiterals(readFileSync(path, 'utf8'), file)) {
      if (file === QR.file && QR.values.some((value) => hit.text.includes(value))) continue
      offenders.push(`${file}:${hit.line} ${hit.match}`)
    }
  }
  assert.deepEqual(offenders, [], 'use a color token from index.css instead')
})

test('control: a palette class and a hex value are caught; a comment and a token class are not', () => {
  const hits = findColorLiterals(
    [
      '// issue #123 is not a color',
      "const a = <div className=\"rounded bg-white px-2\" />",
      "const b = { color: '#123456' }",
      "const c = `shadow-[0_0_6px_rgba(52,211,153,0.55)]`",
      "const d = 'bg-emerald-400'",
      "const e = 'bg-green text-ink-faint border-hairline'",
    ].join('\n'),
  )
  assert.deepEqual(
    hits.map((hit) => [hit.line, hit.match]),
    [
      [2, 'bg-white'],
      [3, '#123456'],
      [4, 'rgba('],
      [5, 'bg-emerald-400'],
    ],
  )
})
