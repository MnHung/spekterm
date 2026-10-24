/**
 * **被測 app 的 UI 語言是被指定的，不是碰巧的。**
 *
 * ## 失效方向決定了這件事為何非做不可
 *
 * 驗收腳本以文案定位介面元素（`scripts/lib/copy.mjs` 自基準語言的字典組出 `aria-label`
 * 選擇器，11 支探針、數百處）。被測 app 若以另一種語言啟動，**症狀是「選不到元素」** ——
 * 探針拿到 `null`，然後以一種看起來像產品壞掉的方式紅掉。那不像驗收設定錯了。
 *
 * 而首次啟動的語言取自作業系統的偏好語言（見 `ui-localization`），**探針的 profile 是全新的**
 * —— 於是在一台非英文的開發機上，每一支探針都會以開發者的語言啟動。
 *
 * ## 只在偏好檔不存在時寫入
 *
 * 兩個段落刻意自己佈置那個檔案，而它們不該被這裡蓋掉：
 *
 * - **損毀韌性**：它要的就是一份壞掉的 `preferences.json`。
 * - **既有偏好**：它要的是一份沒有 `ui` 區塊的舊檔。
 *
 * 「不存在才寫」讓這兩者不必列為例外 —— 它們寫在前，這裡就不動。真正要不寫的只有
 * **驗證偵測機制本身**的那一段（它要的正是「檔案不存在」），以 `seedLanguage: false` 明示。
 */
/*
 * **The theme is pinned to Dark with the language** (`ui-appearance`). The default is System, and the virtual
 * display resolves System to light, so an unseeded profile would run every probe — and the website's screenshots —
 * in the light palette; `probe:openspec` compares a dark color. The runners clear `GTK_THEME`, which would flip
 * System the other way on the virtual display.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 與產品的 `PREFERENCES_VERSION` 一致。不一致時整檔會被隔離，於是這裡等於沒種。 */
const PREFERENCES_VERSION = 1

/** 驗收執行時的語言 —— 與 `copy.mjs` 讀的那份字典是同一種。 */
export const PROBE_LANGUAGE = 'en'

/**
 * 在 profile 中種下 UI 語言。
 *
 * @param {string} profileDir `--user-data-dir` 指向的目錄
 * @param {{ language?: string, theme?: string }} [options]
 * @returns {string | null} 寫出的檔案路徑；因既有檔案而略過時回 `null`
 */
export const PROBE_THEME = 'dark'

export function seedLanguage(profileDir, { language = PROBE_LANGUAGE, theme = PROBE_THEME } = {}) {
  const file = join(profileDir, 'preferences.json')
  if (existsSync(file)) return null

  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify({ version: PREFERENCES_VERSION, terminal: {}, ui: { language, theme } }, null, 2)}\n`,
    'utf8',
  )
  return file
}
