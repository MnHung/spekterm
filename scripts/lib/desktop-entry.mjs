/**
 * 桌面整合的路徑解析與檔案內容 —— 安裝與移除**共用同一份定義**。
 *
 * ## 為什麼路徑全部經環境變數解析
 *
 * **這是驗收的前提，不是可攜性的裝飾。** 把 `HOME` 與 `XDG_*` 指向暫存目錄，就能完整驗證
 * 安裝、重複安裝、移除、產物不存在時的失敗 —— 全部在秒級，且不碰作者真正的桌面環境。
 * 寫死 `~/.local/share` 的話，那一整組 scenario 就只剩人工驗收。
 *
 * ## `XDG_BIN_HOME` 不是 freedesktop 的正式標準
 *
 * XDG Base Directory Spec 只說「使用者的可執行檔**可以**放在 `$HOME/.local/bin`」，
 * 並未定義對應的環境變數。**這裡仍然支援它，理由就是上一段** —— 不要把它讀成標準。
 */

import { join } from 'node:path'

/** 安裝後的產物檔名 —— **不帶版本**，這正是「執行目標不隨版本改變」的實作。 */
export const BINARY_NAME = 'Spekterm.AppImage'
const ENTRY_NAME = 'spekterm.desktop'
const ICON_NAME = 'spekterm.png'

/** @param {NodeJS.ProcessEnv} env */
export function desktopPaths(env) {
  const home = env.HOME ?? ''
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  const binHome = env.XDG_BIN_HOME || join(home, '.local', 'bin')

  return {
    binary: join(binHome, BINARY_NAME),
    entry: join(dataHome, 'applications', ENTRY_NAME),
    icon: join(dataHome, 'icons', 'hicolor', '512x512', 'apps', ICON_NAME),
  }
}

/**
 * `.desktop` 的內容。
 *
 * - **`Exec` 為絕對路徑**（`~` 在 `.desktop` 裡不展開）。
 * - **`Icon` 用絕對路徑而非圖示名。** 圖示名要對就得依賴 `gtk-update-icon-cache` 與主題查找，
 *   而那條路失敗時**沒有任何訊息** —— 選單只會安靜地顯示一個預設齒輪。代價是放棄多解析度，
 *   而我們本來就只有一張 512×512。
 * - **`StartupWMClass` 必須有**，否則執行中的視窗不會與選單圖示歸為一組。Its value is the main
 *   window's WM_CLASS, **`spekterm`, not `productName`** — measured with `xprop` on the packaged app:
 *   the main window is `("spekterm", "spekterm")`, from the desktop name `spekterm.desktop`; only a
 *   10×10 leader window carries `Spekterm`. It once said `Spekterm` here, matching that leader window
 *   rather than the window people click. The AppImage's own entry agrees since `package.json` has
 *   `desktopName` (`syncDesktopName` writes it from there); `desktop-name.test.mjs` keeps the names in step.
 */
export function desktopEntry({ binary, icon }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Spekterm',
    'Comment=Spec-driven multi-agent development workbench',
    `Exec=${binary}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=spekterm',
    '',
  ].join('\n')
}
