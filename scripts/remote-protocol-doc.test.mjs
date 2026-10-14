/**
 * remote-protocol: "The protocol is documented, and the document matches the server".
 *
 * `docs/remote-protocol.md` is the contract the Android repository builds against. Every operation the
 * server accepts — the dispatcher's allow-list (`OPERATIONS` in `src/main/remote-protocol.ts`) plus the two the
 * listener handles before authentication (`AUTH_OPERATIONS`) — must have a `### \`name\`` heading there, and
 * the document must name no operation the server does not accept.
 *
 * Read from the source with the TypeScript parser, not by importing it: this test must not depend on a
 * loader, and the allow-list is a literal table.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROTOCOL = join(repoRoot, 'src', 'main', 'remote-protocol.ts')
const DOC = join(repoRoot, 'docs', 'remote-protocol.md')

export function serverOperations(source) {
  const file = ts.createSourceFile('remote-protocol.ts', source, ts.ScriptTarget.Latest, true)
  const names = []
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      let init = node.initializer
      while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init))) init = init.expression
      if (node.name.text === 'OPERATIONS' && init && ts.isObjectLiteralExpression(init)) {
        for (const property of init.properties) {
          if (property.name && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))) names.push(property.name.text)
        }
      }
      if (node.name.text === 'AUTH_OPERATIONS' && init && ts.isArrayLiteralExpression(init)) {
        for (const element of init.elements) if (ts.isStringLiteral(element)) names.push(element.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names.sort()
}

export function documentedOperations(markdown) {
  return [...markdown.matchAll(/^### `([a-z][a-zA-Z.]*)`\s*$/gm)].map((match) => match[1]).sort()
}

function difference(server, doc) {
  return {
    undocumented: server.filter((name) => !doc.includes(name)),
    unknown: doc.filter((name) => !server.includes(name)),
  }
}

test('the protocol document lists exactly the operations the server accepts', () => {
  const server = serverOperations(readFileSync(PROTOCOL, 'utf8'))
  const doc = documentedOperations(readFileSync(DOC, 'utf8'))
  assert.ok(server.length > 15, `the source scan found only ${server.length} operations`)
  assert.ok(server.includes('hello') && server.includes('conversation.send'))
  assert.deepEqual(difference(server, doc), { undocumented: [], unknown: [] })
})

test('control: a document missing an operation fails and names it', () => {
  const server = serverOperations(readFileSync(PROTOCOL, 'utf8'))
  const doc = documentedOperations(readFileSync(DOC, 'utf8').replace(/^### `terminal\.input`\s*$/m, ''))
  assert.deepEqual(difference(server, doc).undocumented, ['terminal.input'])
})

test('control: an operation documented but not accepted fails and names it', () => {
  const server = serverOperations(readFileSync(PROTOCOL, 'utf8'))
  const doc = documentedOperations(`${readFileSync(DOC, 'utf8')}\n### \`fs.writeFile\`\n`)
  assert.deepEqual(difference(server, doc).unknown, ['fs.writeFile'])
})
