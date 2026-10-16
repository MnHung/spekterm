/**
 * 通知的應用程式身分與安裝的 desktop entry 必須指同一個檔案。
 *
 * **實測**：不設 `setDesktopName` 時，通知的 `desktop-entry` 提示是 `electron` —— 桌面環境
 * 用它去找 `.desktop` 決定圖示與歸類，對不上就拿到 Electron 的預設圖示。而 `agent-intake`
 * 對通知的整條論證建立在「它看起來像作業系統在替**這個 app** 說話」。
 *
 * 兩個值住在**不同的執行環境**（主行程的 TypeScript、建置腳本的 mjs），主行程 import 不了
 * `scripts/`。於是它們只能各寫一份 —— 而兩份字面值遲早會失去同步，**且失效完全靜默**
 * （通知照跳，只是圖示是別人的）。這道守衛就是那個同步。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function literalOf(file, pattern) {
  const source = readFileSync(join(repoRoot, file), 'utf8')
  const match = source.match(pattern)
  assert.ok(match, `${file} 中找不到該常數 —— 它被改名或刪掉了`)
  return match[1]
}

test('主行程宣告的 desktop entry 名稱與安裝腳本使用的相同', () => {
  const fromMain = literalOf('src/main/index.ts', /const DESKTOP_ENTRY_NAME = '([^']+)'/)
  const fromScript = literalOf('scripts/lib/desktop-entry.mjs', /const ENTRY_NAME = '([^']+)'/)
  assert.equal(fromMain, fromScript)
})

test('package.json declares the same desktop name, so the packaged entry and window class agree', () => {
  const { desktopName } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const fromScript = literalOf('scripts/lib/desktop-entry.mjs', /const ENTRY_NAME = '([^']+)'/)
  assert.equal(desktopName, fromScript, 'electron-builder names the AppImage entry and its StartupWMClass from desktopName')
  assert.ok(
    readFileSync(join(repoRoot, 'scripts/lib/desktop-entry.mjs'), 'utf8').includes(`StartupWMClass=${fromScript.replace(/\.desktop$/, '')}`),
    'the installed entry must name the same window class',
  )
})

test('主行程真的設定了它（否則守衛在守一個沒有人用的常數）', () => {
  const source = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
  assert.ok(
    source.includes('setDesktopName'),
    '不設定的話提示會是 electron，通知拿到的是別人的圖示',
  )
})
