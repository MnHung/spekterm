/**
 * What in a source file could open a network connection: the scanner behind
 * `scripts/network-surface.test.mjs` (`workspace-app-shell`: "The app's own code connects only where its
 * allow-list says"). Pure — it reads one file's text and reports; the allow-lists live in the test.
 *
 * Syntax tree, not a regex: comments in this repository name these APIs, and the shapes that matter
 * (`x ?? fetch`, `globalThis['fetch']`, `const { fetch: f } = globalThis`) are not calls.
 */
import ts from 'typescript'

/** Globals that open connections. Counted wherever the name appears outside a type. */
const NETWORK_GLOBALS = new Set(['fetch', 'WebSocket', 'EventSource'])

/**
 * Electron and Node members that open connections or make Chromium do so. Counted wherever the name
 * appears outside a type. `net` is only counted as an import from `electron` (the word is too common).
 * `shell.openExternal` is deliberately absent: it hands a URL the user clicked to their browser.
 */
const NETWORK_MEMBERS = new Set([
  'autoUpdater',
  'crashReporter',
  'downloadURL',
  'loadURL',
  'setSpellCheckerDictionaryDownloadURL',
])

const normalizeModule = (name) => name.replace(/^node:/, '')

const isEmptyArrayLiteral = (node) => ts.isArrayLiteralExpression(node) && node.elements.length === 0

/**
 * @param {string} fileName for the parser's script kind and the report
 * @param {string} text
 * @returns {{ apis: { api: string, line: number }[], modules: { module: string, line: number }[] }}
 */
export function scanSource(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const apis = []
  const modules = []
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const addModule = (literal) => {
    const name = literal.text
    if (name.startsWith('.')) return // a file of this repository
    modules.push({ module: normalizeModule(name), line: lineOf(literal) })
  }

  const visit = (node) => {
    // Types open no connections: `typeof fetch` in an annotation, `WebSocket` as a type.
    if (ts.isTypeNode(node)) return
    // A type-only import names a type, which cannot open a connection (`import { type WebSocket } from 'ws'`).
    if (ts.isImportSpecifier(node) && (node.isTypeOnly || node.parent?.parent?.isTypeOnly)) return

    if (ts.isIdentifier(node) && (NETWORK_GLOBALS.has(node.text) || NETWORK_MEMBERS.has(node.text))) {
      apis.push({ api: node.text, line: lineOf(node) })
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      (NETWORK_GLOBALS.has(node.argumentExpression.text) || NETWORK_MEMBERS.has(node.argumentExpression.text))
    ) {
      apis.push({ api: node.argumentExpression.text, line: lineOf(node) })
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setSpellCheckerLanguages' &&
      !(node.arguments.length === 1 && isEmptyArrayLiteral(node.arguments[0]))
    ) {
      apis.push({ api: 'setSpellCheckerLanguages(non-empty)', line: lineOf(node) })
    }

    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) addModule(node.moduleSpecifier)
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : undefined
      if (
        bindings &&
        ts.isNamedImports(bindings) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'electron'
      ) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'net') apis.push({ api: 'net', line: lineOf(element) })
        }
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) addModule(node.arguments[0])
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression
      if (ts.isStringLiteralLike(expression)) addModule(expression)
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
  return { apis, modules }
}
