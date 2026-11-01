import { spawn } from 'node:child_process'
import { basename } from 'node:path'

/**
 * 讓主行程與終端 session 取得使用者**互動** shell 所建立的環境。
 *
 * **為什麼需要它**：自桌面環境啟動的產物只繼承系統預設 PATH，且完全沒有使用者互動 rc
 * （`.zshrc` / `.bashrc`）所設定的任何變數。`terminal.ts` 的 login shell 機制只對 spawn 目標為
 * login shell 的 session 有效 —— agent CLI 目標以**非互動**方式執行命令，不讀那些 rc 檔；
 * 主行程自己 spawn 的東西（core 用來取得 schema 權威順序的 `openspec`）更完全不受它影響。
 *
 * **取回的東西分兩路，而那道分界是承重的：**
 *
 * | | 去哪 | 為什麼 |
 * |---|---|---|
 * | `PATH` | 併進 `process.env.PATH` | 主行程 spawn 的外部程式要解析得到 |
 * | 其餘變數 | **只**存在這裡，由 `getUserEnv()` 交給 pty | 見下 |
 *
 * **其餘變數 SHALL NOT 寫進 `process.env`。** 主行程的環境決定應用程式自身的行為 ——
 * userData 的落點（`app.getPath('userData')`）與 CSP 的 dev／production 判定
 * （`ELECTRON_RENDERER_URL`）都在 `whenReady` 內求值，而本模組於 module load 觸發、不被 await，
 * 兩者之間是一個競賽窗口（實測約 220ms，而一個精簡的 `.zshrc` 只要 0.02–0.24s）。
 *
 * **「只在原本不存在時才加入」這條規則救不了它** —— 實測一個自桌面選單啟動的產物（49 個變數）：
 *
 * ```
 * DISPLAY               存在        XDG_CONFIG_HOME       **不存在**
 * HOME                  存在        NODE_OPTIONS          **不存在**
 *                                   ELECTRON_RENDERER_URL **不存在**
 *                                   ELECTRON_RUN_AS_NODE  **不存在**
 * ```
 *
 * 危險的那幾個**不在啟動環境裡**，於是「不存在才加入」對它們一律放行 —— 方向與直覺相反。
 * 而一份「不可覆寫」的黑名單會遺漏尚未存在的變數（下一個 Electron 版本新增的那些），
 * 且遺漏是靜默的。**不寫進去，這一整類問題就表達不出來。**
 *
 * 套用只發生在一個確定的時點（見 `index.ts`），不在任何功能的使用點。
 */

/**
 * 包夾使用者環境的標記，以及取得它的命令。
 *
 * **標記與分隔符都是 NUL，而那是結構性保證不是機率論證**：`execve(2)` 讓環境變數的名字與值
 * **不可能**含有 NUL，於是「標記或分隔符與內容混淆」表達不出來。此前用的 `@@` 不具這個性質 ——
 * 一個值為 `line1\nline2 with 'quote' and @@ mark` 的變數會在它身上截斷。
 *
 * 取**最後一組**標記之後的內容：互動 rc 印東西到 stdout 是常態，而我們的 `printf` 恆為最後執行的。
 *
 * **命令是固定的字串常數，沒有任何拼接** —— 這是選 `env -0` 而非「讓 shell 執行我們的
 * `process.execPath` 以 node 模式印 JSON」的主要理由（後者要把一個路徑拼進 shell 命令）。
 * `env -0` began as a GNU coreutils flag, but **macOS's `env` supports it too** (measured on macOS 13.7:
 * NUL-separated entries, `macos-dmg-packaging` design). An `env` without it makes the markers unparseable,
 * and the query then gives up (＝退回今天的行為).
 *
 * **驗證「`printf '\0'` 真的印得出 NUL」時不可經 `$(...)`** —— command substitution 會剝掉 NUL，
 * 於是會量到相反的結論。要直接 pipe（`| od -c`）。
 */
const MARK = '\0__SPEKTERM_ENV__\0'
const QUERY = "printf '\\0__SPEKTERM_ENV__\\0'; env -0"

/**
 * 能以 `-i -l -c` 安全查詢的 shell。
 *
 * **白名單而非黑名單，因為失敗是靜默的**：未知 shell 對「以互動方式執行一個命令」的語意、
 * 以及 `env -0` 在其上的可用性皆未經實測。放棄的代價只是「沒修好」，猜錯的代價是「悄悄取回
 * 一份不完整或空的環境」。
 *
 * > **原本的理由已經不成立，不要照著它推論。** 此前的理由是「`fish` 的 `$PATH` 是一個 list
 * > 而非以 `:` 連接的字串」—— 那對「讀 `$PATH` 這個 shell 變數」成立，而**現在的取值方式不讀
 * > 任何 shell 變數**（`env` 是外部程式，其輸出與 shell 無關；fish 匯出 PATH 時仍以 `:` 連接）。
 * > 拿掉這個白名單的條件因此很明確：在目標 shell 上實測「`-i -l -c` 能執行 `env -0` 並取回含
 * > 互動 rc 變數的完整環境」。
 */
const QUERYABLE_SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh'])

/**
 * 逾時。實測互動 login shell 約 1.3 秒（powerlevel10k + gitstatus + nvm + compinit），但那是
 * **熱的** —— 開機後第一次（compinit 快取冷、gitstatus daemon 未起）合理更慢。逾時的代價是
 * 靜默落到退路，所以寧可寬一點。
 */
const TIMEOUT_MS = 5000

/**
 * 自 shell 的輸出取出整份環境。取**最後一組**標記之後的內容，以 NUL 切分為 `KEY=VALUE`。
 *
 * **只收 `Buffer`，不開 `string` 的 union** —— 環境變數的值是任意位元組，以文字編碼讀取會讓
 * 非該編碼的值靜默替換為 U+FFFD**而解析本身不會出錯**。收 `string` 的 union 等於在型別上宣告
 * 「維持現狀也可以」。切分在位元組層級進行，每個值各自解碼，原始位元組保留到最後一刻。
 */
export function parseEnvOutput(stdout: Buffer): Record<string, string> | null {
  const mark = Buffer.from(MARK, 'utf-8')
  const end = stdout.lastIndexOf(mark)
  if (end < 0) return null

  const env: Record<string, string> = {}
  let start = end + mark.length
  while (start < stdout.length) {
    let stop = stdout.indexOf(0, start)
    if (stop < 0) stop = stdout.length
    if (stop > start) {
      const entry = stdout.subarray(start, stop)
      // `=` 在位置 0 不算（那是一個沒有名字的項目）。值本身含 `=` 是合法的，只切第一個。
      const eq = entry.indexOf(0x3d)
      if (eq > 0) {
        env[entry.subarray(0, eq).toString('utf-8')] = entry.subarray(eq + 1).toString('utf-8')
      }
    }
    start = stop + 1
  }

  return Object.keys(env).length > 0 ? env : null
}

/**
 * 合併：使用者 PATH 中**現有 PATH 所無**的項目，前置於現有 PATH 之前。
 *
 * **必須前置，不能附加**（實測）：`openspec` 的 shebang 是 `#!/usr/bin/env node`，附加在後時
 * 它被解析到、但 `node` 仍解析到系統版本而失敗 —— 而 CLI 非零結束在 core 的 provider 眼中
 * **與「未安裝」無法區分**。
 *
 * 現有項目一個都不移除（產物自身注入的路徑要留著）。它們會被排到使用者路徑之後 —— 這是刻意的，
 * 而「不移除」不等於「不受影響」。
 */
export function mergeUserPath(current: string, user: string): string {
  const sep = ':'
  const currentParts = current.split(sep).filter((p) => p.length > 0)
  const seen = new Set(currentParts)

  const added: string[] = []
  for (const part of user.split(sep)) {
    if (part.length === 0 || seen.has(part)) continue
    seen.add(part)
    added.push(part)
  }

  return added.length > 0 ? [...added, ...currentParts].join(sep) : current
}

/** 這個 shell 能不能以 `-i -l -c` 安全查詢（見 `QUERYABLE_SHELLS`）。 */
export function isQueryableShell(shellPath: string): boolean {
  return QUERYABLE_SHELLS.has(basename(shellPath))
}

/** 已啟動的那一次解析（含套用）。`null` ＝ 還沒啟動過。 */
let pending: Promise<void> | null = null

/**
 * 取得成功時，使用者環境中 **`PATH` 以外**的部分。
 *
 * `PATH` 不在裡面是刻意的：它已經併進 `process.env.PATH`，而那份是**超集**（使用者的項目前置、
 * 產物自身注入的在後）。把使用者的原始 `PATH` 也留在這裡，pty 合併時會覆蓋掉合併版而丟失後者。
 */
let userEnv: Readonly<Record<string, string>> = {}

/**
 * 使用者環境中 `PATH` 以外的部分。尚未取得或取得失敗時為空物件 —— 呼叫端因此不需要處理 `null`。
 *
 * **這是給 pty 用的**（見 `terminal.ts` 的 `ptyEnv`）。主行程自身**不**消費它，理由見檔頭。
 */
export function getUserEnv(): Readonly<Record<string, string>> {
  return userEnv
}

/**
 * 啟動解析，並在完成時**套用一次**：`PATH` 併進 `process.env.PATH`，其餘存入 `userEnv`。
 *
 * **這是唯一的套用點。** 若改在某個功能的使用點才套用，「其他行程有沒有拿到修好的環境」就取決於
 * 使用者有沒有先用過那個功能 —— 順序相依，而且失效方向靜默。
 *
 * 重複呼叫只會解析一次。呼叫端**不該 await 它**（實測互動 shell 約 1.3 秒，不該擋住視窗建立）；
 * 需要對齊時序的路徑用 `whenUserEnvReady()`。
 */
export function applyUserEnvOnce(): Promise<void> {
  pending ??= startUserEnvResolution().then((resolved) => {
    if (resolved === null) {
      failed = !resolutionSkipped()
      return
    }

    const { PATH: userPath, ...rest } = resolved
    if (userPath !== undefined && userPath.length > 0) {
      process.env.PATH = mergeUserPath(process.env.PATH ?? '', userPath)
    }
    userEnv = rest
  })
  return pending
}

/** Whether the resolution failed or timed out (`restore-running-sessions`). */
let failed = false

/**
 * Whether the user's environment could not be read: the resolution ran and failed (spawn error, non-zero exit,
 * timeout, unparsable output). **A skipped resolution is not a failure** (an unsupported platform or shell): those
 * users always run with the desktop's environment. Meaningful once `whenUserEnvReady()` has resolved.
 *
 * An automatic start refuses agents on a failure (`restore-running-sessions` D3): without the user's `PATH` the
 * agent may not be found, and every resumed agent would then fail, heal and be removed as an ending.
 */
export function userEnvFailed(): boolean {
  return failed
}

/** The same conditions under which `startUserEnvResolution` returns `null` without trying. */
function resolutionSkipped(): boolean {
  return process.platform === 'win32' || !isQueryableShell(process.env.SHELL || '/bin/bash')
}

/**
 * 等待那一次解析結束（**只做時序對齊，不套用**）。從未啟動過時立即完成 —— 單元測試與任何不經
 * `applyUserEnvOnce()` 的路徑因此不會卡住。
 */
export function whenUserEnvReady(): Promise<void> {
  return pending ?? Promise.resolve()
}

/**
 * 取得使用者互動 shell 的整份環境。回 `null` ＝ 放棄（維持原狀）。
 *
 * **必須是互動的（`-i`）**：非互動的 login shell 不 source `.zshrc` / `.bashrc`，而 nvm 之屬正是
 * 在那裡初始化的，只在那裡設定的變數（API 憑證、服務端點）同理。實測
 * `zsh -l -c 'command -v openspec'` 無輸出，`zsh -i -l -c` 才找得到。
 *
 * 呼叫端**不需要**處理錯誤：任何失敗（平台不支援、shell 不在白名單、spawn 失敗、非零結束、
 * 逾時、解析不出標記）都 resolve 為 `null`。
 */
export function startUserEnvResolution(): Promise<Record<string, string> | null> {
  if (process.platform === 'win32') return Promise.resolve(null)

  const shell = process.env.SHELL || '/bin/bash'
  if (!isQueryableShell(shell)) {
    console.warn(`[user-env] skipped: ${basename(shell)} is not a shell we can query safely`)
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false

    // 計時器在 spawn 成功之後才建立，但 `finish` 必須在那之前就能引用它（spawn 失敗那條路也會
    // 呼叫 finish）。以持有者物件表達這個先後關係 —— `clearTimeout(undefined)` 是合法的 no-op。
    const timeout: { id?: NodeJS.Timeout } = {}
    const finish = (value: Record<string, string> | null, why?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout.id)
      if (value === null && why) console.warn(`[user-env] ${why}`)
      resolve(value)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, ['-i', '-l', '-c', QUERY], {
        // stderr **丟棄，而不是接一條沒人 drain 的 pipe** —— 實測互動 zsh 在非 tty 下噴十行以上
        // 的 gitstatus 錯誤，pipe 滿了會讓子行程卡到逾時。
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch (error) {
      finish(null, `spawn failed: ${String(error)}`)
      return
    }

    // 逾時**必須把子行程收掉** —— 否則每次啟動都可能留下一個等待中的互動 shell。
    timeout.id = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null, `timed out after ${TIMEOUT_MS}ms`)
    }, TIMEOUT_MS)

    // **不設 encoding** —— 環境變數的值是任意位元組，見 `parseEnvOutput`。
    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    child.on('error', (error) => finish(null, `spawn error: ${error.message}`))
    child.on('close', (code) => {
      if (code !== 0) return finish(null, `shell exited with ${code}`)
      const parsed = parseEnvOutput(Buffer.concat(chunks))
      // **只印數量與名字，絕不印值** —— 這裡面有 API 憑證。
      finish(parsed, parsed === null ? 'could not parse environment from shell output' : undefined)
    })
  })
}
