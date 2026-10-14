/**
 * secret-scope：機密的作用域邊界，三道原始碼守衛。
 *
 * 這條能力的每一種失效都是**靜默**的：機密流向 renderer 不會有錯誤、進了子行程環境不會有錯誤、
 * 印進 log 不會有錯誤。因此「記得不要把它加進去」不是處置，把出口逐一堵住才是。
 *
 * ## 三道守衛，各自擋不同的東西
 *
 * ### ① `process.env` 的指派只允許一個地方
 *
 * **這是最重要的一道，而它此前完全沒有東西在守。** `ptyEnv()`（`terminal.ts`）是
 * `{ ...process.env, ...getUserEnv(), TERM }` —— 因此**任何模組往 `process.env` 寫一個值，
 * 那個值就會進到每一個 pty**，而那個模組不必是 `terminal.ts`、也不必被它 import。
 * 第三方服務的用戶端套件正是最可能這樣做的地方（許多套件讀約定俗成的環境變數）。
 *
 * CLAUDE.md 早就把這條列為承重（「絕不要『順手』把它們也 `Object.assign` 進 `process.env`」），
 * 而那條紀律的失效方式在文件裡也寫著：一個被注入的 `XDG_CONFIG_HOME` 會換掉 userData 的落點
 * ——**所有 repo 與 session 消失，而它們的 pty 還活著**。
 *
 * 唯一的豁免是 `user-env.ts`：它是那份文件所述「唯一的套用點」，只把 `PATH` 併進去。
 * **豁免是檔案層級而不是「某一行」**，因為它就是那個決定要套用什麼的模組。
 *
 * ### ② 建構子行程環境與偏好都取用不到機密
 *
 * ① 擋的是「把值寫進共用的環境」，這一道擋的是「把值直接放進某個子行程的 env 物件」——
 * 兩者是不同的動作，各自都做得到，所以各自都要擋。定義域見 `SECRET_FORBIDDEN`：三個建構子行程
 * 環境的模組，**外加偏好**（它持有的物件會被投影到 renderer，所以它根本不該知道機密的存在）。
 *
 * ### ③ 解開機密只能在白名單模組中發生
 *
 * `Secret.reveal()` 是取得明文的唯一入口，於是「誰真的用到了它」可以被釘住。這道守衛使
 * **網路那條出口**（`secret-scope` 的第四條，隨本次新增而出現）也變成結構性的：把憑證送到
 * 一個不是該服務的主機，必須先在這份白名單上出現。
 *
 * 白名單目前有兩個：機密模組自己（寫檔）與 Slack 的 HTTP 用戶端（`Authorization` header）。
 * **往裡面加一個名字是一個刻意的動作，而那正是重點** —— 這份清單就是「憑證會被送到哪裡」的
 * 清查起點。
 *
 * ## 走語法樹，不逐行比對
 *
 * 本檔案與被守的模組，其註解都會談到 `process.env`、`reveal()` 與 `secret-store`，
 * 逐行掃描會把它們全部誤判。註解是 trivia，不在語法樹的節點裡，因此自動豁免
 * （比照 `watcher-source.test.mjs` 與 `terminal-resize-source.test.mjs`）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep as path_sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = join(repoRoot, 'src')

/** 唯一允許指派 `process.env` 的模組 —— 使用者環境「唯一的套用點」。 */
const ENV_APPLY_POINT = join('src', 'main', 'user-env.ts')

/** 持有機密的模組。 */
const SECRET_MODULE = join('src', 'main', 'secret-store.ts')

/**
 * 取用不到機密的模組 —— 兩類，而兩類擋的出口不同：
 *
 * - **建構子行程環境的**（`user-env` / `terminal` / `report-runner`）：它們的產出會成為 pty 或
 *   委派行程的環境，而那些行程由不受信任的內容驅動。
 * - **偏好**（`preferences-store`）：它持有的物件**會被投影到 renderer**，所以它根本不該知道
 *   機密的存在。這一條與「機密自己一份檔案」是同一個約束的兩面：分家由結構保證，
 *   而不是由「沒有人再把它塞進去」保證。
 */
const SECRET_FORBIDDEN = [
  join('src', 'main', 'user-env.ts'),
  join('src', 'main', 'terminal.ts'),
  join('src', 'main', 'report-runner.ts'),
  join('src', 'main', 'preferences-store.ts'),
]

/**
 * 允許解開機密（呼叫 `reveal()`）的模組。**這份清單就是「誰會處理明文」的答案**，
 * 往裡面加一個名字＝宣告那件事，而那要是一個刻意的動作。
 *
 * - `secret-store.ts` —— 它要把值寫進檔案。
 * - `slack-api.ts` —— 它要把憑證放進 `Authorization` header。**這是網路那條出口**
 *   （`secret-scope` 的第四條），因此這份白名單同時是「憑證會被送到哪裡」的清查起點。
 * - `remote-store.ts` —— it reads the remote access listener's TLS private key (`remote.tlsKey`) to hand it
 *   to the TLS server in the same process. That key never leaves the main process (`remote-access`); it is
 *   not sent anywhere — the listener only presents the certificate.
 */
const REVEAL_ALLOWLIST = [SECRET_MODULE, join('src', 'main', 'slack-api.ts'), join('src', 'main', 'remote-store.ts')]

/** `reveal()` 的方法名。 */
const REVEAL = 'reveal'

/**
 * 端點的寫入方法，與**唯一**允許呼叫它的模組。
 *
 * `secret-scope` 要求端點「只能由使用者明確操作改動，SHALL NOT 由投遞內容、routing 規則或
 * 任何其他外部輸入寫入」。它是**憑證的目的地**（使用者裁決把它做成設定項），所以那條要求
 * 必須是結構性的：只有那個綁在使用者動作上的 IPC 處理常式可以呼叫它。
 *
 * **定義域限於 `src/main/**`，而那是刻意的。** 威脅是「主行程用不受信任的輸入寫端點」——
 * 投遞的本文、routing 規則、環境變數。renderer 的呼叫是**點擊處理常式**，它就是那個
 * 「使用者明確操作」；而它寫進去的值仍然要過主行程的 scheme 白名單。
 * 把 renderer 一併納入只會讓這道守衛擋住它該允許的那條路。
 */
const ENDPOINT_SETTER = 'setApiBaseUrl'
const ENDPOINT_WRITERS = [
  join('src', 'main', 'ipc', 'slack.ts'),
  join('src', 'main', 'slack-settings-store.ts'),
]

/** 機密模組的 import 路徑長什麼樣（`./secret-store`、`../secret-store`…）。 */
const SECRET_MODULE_SPECIFIER = /(^|\/)secret-store$/

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

/** 一個節點是不是 `process.env`（或 `process.env[...]` / `process.env.X` 的那個基底）。 */
function isProcessEnv(node, sourceFile) {
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    node.expression.getText(sourceFile) === 'process' &&
    (ts.isPropertyAccessExpression(node)
      ? node.name.text === 'env'
      : ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'env')
  )
}

/** 一個節點是不是「`process.env` 的某個成員」（`process.env.X` / `process.env[x]`）。 */
function isProcessEnvMember(node, sourceFile) {
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isProcessEnv(node.expression, sourceFile)
  )
}

/** 找出對 `process.env` 的寫入 —— 三種形式。 */
export function findProcessEnvWrites(source, fileName = 'sample.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found = []

  const visit = (node) => {
    // ① `process.env.X = …` / `process.env[x] = …`（含 `+=`、`??=` 之類的複合指派）。
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      isProcessEnvMember(node.left, sourceFile)
    ) {
      found.push({ line: lineOf(sourceFile, node), kind: 'env-member-assignment' })
    }

    // ② `delete process.env.X` —— 同樣是改共用環境。
    if (
      ts.isDeleteExpression(node) &&
      isProcessEnvMember(node.expression, sourceFile)
    ) {
      found.push({ line: lineOf(sourceFile, node), kind: 'env-member-delete' })
    }

    // ③ `Object.assign(process.env, …)` —— CLAUDE.md 指名的那一個形式。
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sourceFile) === 'Object.assign' &&
      node.arguments.length > 0 &&
      isProcessEnv(node.arguments[0], sourceFile)
    ) {
      found.push({ line: lineOf(sourceFile, node), kind: 'env-object-assign' })
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

/** 找出對機密模組的 import（型別匯入也算 —— 型別拿不到值，但這道守衛要的是「完全不碰」）。 */
export function findSecretImports(source, fileName = 'sample.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found = []

  const visit = (node) => {
    const spec =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined
    if (spec !== undefined && ts.isStringLiteral(spec) && SECRET_MODULE_SPECIFIER.test(spec.text)) {
      found.push({ line: lineOf(sourceFile, node), kind: 'secret-import' })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

/** 找出對端點 setter 的呼叫。 */
export function findEndpointWrites(source, fileName = 'sample.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found = []

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === ENDPOINT_SETTER
    ) {
      found.push({ line: lineOf(sourceFile, node), kind: 'endpoint-write' })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

/** 找出 `….reveal()` 的呼叫。 */
export function findRevealCalls(source, fileName = 'sample.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found = []

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === REVEAL
    ) {
      found.push({ line: lineOf(sourceFile, node), kind: 'reveal-call' })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

/** 測試檔不出貨，且它們正需要談論這些東西（例如刻意設定 `process.env` 造前置條件）。 */
function isProductSource(path) {
  if (!/\.tsx?$/.test(path)) return false
  return !/\.test\.tsx?$/.test(path)
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

function productSources() {
  const files = []
  for (const path of walk(srcRoot)) {
    if (!isProductSource(path)) continue
    files.push({ rel: relative(repoRoot, path), source: readFileSync(path, 'utf8') })
  }
  return files
}

test('① process.env 的指派只出現在使用者環境唯一的套用點', () => {
  const offenders = []
  for (const { rel, source } of productSources()) {
    if (rel === ENV_APPLY_POINT) continue
    for (const hit of findProcessEnvWrites(source, rel)) {
      offenders.push(`${rel}:${hit.line}: ${hit.kind}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `只有 ${ENV_APPLY_POINT} 可以寫 process.env。\n` +
      'ptyEnv() 展開 process.env，所以任何模組往它寫一個值，那個值就會進到每一個 pty ——\n' +
      '而那個模組不必是 terminal.ts、也不必被它 import。第三方 SDK 正是最愛這樣做的地方。\n' +
      '被注入的 XDG_CONFIG_HOME 更會換掉 userData 的落點：所有 repo 與 session 消失。\n\n' +
      offenders.join('\n'),
  )
})

test('② 建構子行程環境與偏好都取用不到機密', () => {
  const offenders = []
  for (const { rel, source } of productSources()) {
    if (!SECRET_FORBIDDEN.includes(rel)) continue
    for (const hit of findSecretImports(source, rel)) {
      offenders.push(`${rel}:${hit.line}: ${hit.kind}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `以下模組不得取用機密：\n  ${SECRET_FORBIDDEN.join('\n  ')}\n` +
      '建構子行程環境的三個，其產出會成為 pty 或委派行程的環境（由不受信任的內容驅動）；\n' +
      'preferences-store 持有的物件會被投影到 renderer，它根本不該知道機密的存在。\n\n' +
      offenders.join('\n'),
  )
})

test('③ 解開機密只發生在白名單模組中', () => {
  const offenders = []
  for (const { rel, source } of productSources()) {
    if (REVEAL_ALLOWLIST.includes(rel)) continue
    for (const hit of findRevealCalls(source, rel)) {
      offenders.push(`${rel}:${hit.line}: ${hit.kind}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `reveal() 是取得明文的唯一入口，只能在白名單模組中被呼叫：\n` +
      `  ${REVEAL_ALLOWLIST.join('\n  ')}\n` +
      '往白名單加一個名字＝宣告「這個模組會處理明文」，那要是一個刻意的動作 ——\n' +
      '特別是網路那條出口：把憑證送到一個不是該服務的主機，必須先在這份白名單上出現。\n\n' +
      offenders.join('\n'),
  )
})

test('④ 端點只由綁在使用者動作上的處理常式寫入', () => {
  const offenders = []
  const mainRoot = join('src', 'main') + path_sep
  for (const { rel, source } of productSources()) {
    if (!rel.startsWith(mainRoot)) continue
    if (ENDPOINT_WRITERS.includes(rel)) continue
    for (const hit of findEndpointWrites(source, rel)) {
      offenders.push(`${rel}:${hit.line}: ${hit.kind}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `端點是憑證的目的地，只能由使用者明確操作改動。允許寫入的模組：\n  ${ENDPOINT_WRITERS.join('\n  ')}\n` +
      '它 SHALL NOT 由投遞內容、routing 規則或任何其他外部輸入寫入 ——\n' +
      '那條要求必須是結構性的，因為「把憑證送到別處」不會有任何錯誤。\n\n' +
      offenders.join('\n'),
  )
})

test('對照組：三種 process.env 寫入形式各自被抓到', () => {
  const member = findProcessEnvWrites("process.env.SLACK_TOKEN = token")
  assert.equal(member.length, 1, '具名指派應被抓到')
  assert.equal(member[0].kind, 'env-member-assignment')

  const computed = findProcessEnvWrites("process.env[key] = token")
  assert.equal(computed.length, 1, '計算鍵指派應被抓到')

  const compound = findProcessEnvWrites("process.env.PATH ??= '/usr/bin'")
  assert.equal(compound.length, 1, '複合指派應被抓到')

  const removed = findProcessEnvWrites('delete process.env.SLACK_TOKEN')
  assert.equal(removed.length, 1, 'delete 應被抓到')
  assert.equal(removed[0].kind, 'env-member-delete')

  const assigned = findProcessEnvWrites('Object.assign(process.env, secrets)')
  assert.equal(assigned.length, 1, 'Object.assign 應被抓到')
  assert.equal(assigned[0].kind, 'env-object-assign')
})

test('對照組：讀取 process.env 與別的物件不被誤報', () => {
  const reads = findProcessEnvWrites(
    [
      'const home = process.env.HOME',
      "const env = { ...process.env, TERM: 'xterm-256color' }",
      'const value = input.processEnv[key]',
      // 寫進一個**自己的** env 物件是合法的 —— 那不是共用環境。
      "env.PATH = process.env.PATH ?? ''",
      'Object.assign(target, source)',
    ].join('\n'),
  )
  assert.deepEqual(reads, [], `讀取或寫別的物件被誤報：${JSON.stringify(reads)}`)
})

test('對照組：機密的 import 與 reveal 各種形式被抓到，無關的不被誤報', () => {
  const staticImport = findSecretImports("import { SecretStore } from './secret-store'")
  assert.equal(staticImport.length, 1, '靜態 import 應被抓到')

  const typeImport = findSecretImports("import type { Secret } from '../secret-store'")
  assert.equal(typeImport.length, 1, '型別 import 也算 —— 這道守衛要的是「完全不碰」')

  const dynamicImport = findSecretImports("const m = await import('./secret-store')")
  assert.equal(dynamicImport.length, 1, '動態 import 應被抓到')

  const unrelated = findSecretImports("import { PreferencesStore } from './preferences-store'")
  assert.deepEqual(unrelated, [], `無關的 import 被誤報：${JSON.stringify(unrelated)}`)

  // **這個對照組指名的是「主行程用不受信任的輸入寫端點」** —— 投遞的本文正是那種輸入。
  const endpoint = findEndpointWrites('settings.setApiBaseUrl(intake.body)')
  assert.equal(endpoint.length, 1, '端點的寫入應被抓到')
  assert.equal(endpoint[0].kind, 'endpoint-write')

  const reveal = findRevealCalls('const plain = secret.reveal()')
  assert.equal(reveal.length, 1, 'reveal() 應被抓到')

  const nested = findRevealCalls('headers.Authorization = `Bearer ${store.get(name).reveal()}`')
  assert.equal(nested.length, 1, '巢狀的 reveal() 應被抓到')
})
