/**
 * Every colour-family utility in the renderer must produce CSS.
 *
 * Tailwind silently drops a class it cannot resolve. `text-ink-muted` (23 places) and `bg-surface`
 * (4 places) named colours that `index.css` never defined: the inbox's secondary text was meant to be
 * dim and rendered at full brightness, the conversation view's cards had no background, and nothing went
 * red — no type error, no lint, no probe. This guard compiles the candidates with the renderer's own
 * `index.css` and fails on any that yields no rule.
 *
 * Scope: string literals in `src/renderer/src/**\/*.{ts,tsx}` (read through the TypeScript AST, so
 * comments are not candidates), tokens whose utility is a colour family (`text-`, `bg-`, `border-`,
 * `ring-`, `outline-`, …) with any variants. A template fragment such as `text-${x}` is skipped: it is
 * not a class until it is filled in.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { compile } from 'tailwindcss'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = join(repoRoot, 'src/renderer/src')
const require = createRequire(import.meta.url)
const tailwindDir = dirname(require.resolve('tailwindcss/package.json'))

const UTILITY =
  /^(?:[^\s:]+:)*-?(?:text|bg|border(?:-[trblxyse])?|ring|outline|accent|fill|stroke|divide|placeholder|caret|decoration|from|via|to)-[^\s]+$/

/** The renderer's stylesheet without the package import, which only adds component classes. */
async function compiler() {
  const css = readFileSync(join(rendererRoot, 'index.css'), 'utf8').replace(/^@import '@spekjs\/ui\/[^']+';$/m, '')
  return compile(css, {
    base: rendererRoot,
    loadStylesheet: async (id, base) => {
      const path = id === 'tailwindcss' ? join(tailwindDir, 'index.css') : require.resolve(id, { paths: [base] })
      return { path, base: dirname(path), content: readFileSync(path, 'utf8') }
    },
  })
}

/** Tailwind's selector for a class: every character outside `[A-Za-z0-9_-]` is escaped. */
const selectorOf = (candidate) => '.' + candidate.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`)

/** The candidates that produce no rule. */
function unresolved(build, candidates) {
  const css = build(candidates)
  return candidates.filter((candidate) => !css.includes(selectorOf(candidate)))
}

function stringsOf(file, source) {
  const out = []
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push({ text: node.text, cutStart: false, cutEnd: false })
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // A token touching a substitution is a fragment; one separated from it by whitespace is whole.
      out.push({
        text: node.text,
        cutStart: !ts.isTemplateHead(node) && !/^\s/.test(node.text),
        cutEnd: !ts.isTemplateTail(node) && !/\s$/.test(node.text),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX))
  return out
}

/** Colour-family tokens in a file, skipping the edges of template fragments (`text-${x}`). */
function candidatesOf(file, source) {
  const found = new Set()
  for (const { text, cutStart, cutEnd } of stringsOf(file, source)) {
    const tokens = text.split(/\s+/)
    tokens.forEach((token, index) => {
      if ((cutStart && index === 0) || (cutEnd && index === tokens.length - 1)) return
      if (UTILITY.test(token)) found.add(token)
    })
  }
  return [...found]
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

test('every colour utility in the renderer resolves to a defined token', async () => {
  const { build } = await compiler()
  const violations = []
  for (const file of sourceFiles(rendererRoot)) {
    const candidates = candidatesOf(file, readFileSync(file, 'utf8'))
    for (const candidate of unresolved(build, candidates)) violations.push(`${relative(repoRoot, file)}: ${candidate}`)
  }
  assert.deepEqual(violations, [], `classes that produce no CSS:\n${violations.join('\n')}`)
})

test('control: an undefined token is caught and defined ones are not', async () => {
  const { build } = await compiler()
  const sample = `const a = 'text-ink-muted hover:bg-surface text-ink-dim hover:bg-hover/60 bg-black/50'
    const b = \`px-2 text-\${tone} border-hairline\``
  const candidates = candidatesOf('sample.tsx', sample)
  assert.ok(!candidates.some((c) => c.startsWith('text-') && c.endsWith('-')), 'a template fragment is not a candidate')
  assert.ok(candidates.includes('border-hairline'), 'a whole token inside a template is a candidate')
  assert.deepEqual(unresolved(build, candidates).sort(), ['hover:bg-surface', 'text-ink-muted'])
})

test('control: a class named only in a comment is not a candidate', () => {
  assert.deepEqual(candidatesOf('sample.tsx', '// text-ink-muted was never defined\nconst a = 1'), [])
})
