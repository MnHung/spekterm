/**
 * Guard (`team-membership`, design D3): the team connection's outcome mapping (`src/main/team-outcome.ts`) has **no
 * `default`** in any `switch`. Its value is that a new close code or error code fails the build until someone
 * decides whether it retries, stops or discards; a `default` would make that decision silently, and nothing would
 * turn red. Read through the syntax tree, so a comment that mentions the word does not count.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = 'src/main/team-outcome.ts'

export function findDefaultClauses(source, fileName = TARGET) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found = []
  const visit = (node) => {
    if (ts.isDefaultClause(node)) found.push(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return found
}

test('the team outcome mapping has no default clause', () => {
  const found = findDefaultClauses(readFileSync(join(repoRoot, TARGET), 'utf8'))
  assert.deepEqual(found, [], `${TARGET} has a default clause at line ${found.join(', ')}`)
})

test('control: a default clause is found, a comment mentioning it is not', () => {
  const mutated = "// no default: here\nfunction f(c: 'a') {\n  switch (c) {\n    case 'a':\n      return 1\n    default:\n      return 2\n  }\n}"
  assert.deepEqual(findDefaultClauses(mutated, 'm.ts'), [6])
})
