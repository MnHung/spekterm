import fs from 'node:fs'
import path from 'node:path'

/**
 * 應用程式代使用者持有的**機密**（第三方服務的憑證），其保管與作用域邊界。
 *
 * ## 為什麼自己一份檔案，不寄居偏好
 *
 * 三個各自成立的理由：
 *
 * 1. **偏好會被投影到 renderer**（`preferences-store.ts` 的 `projectPreferences`）。
 * 2. 偏好檔的寫入路徑**自空物件重建**其內容，寄居其中的欄位倚賴每一個寫入者記得保留它 ——
 *    `agentStatus` 就是那樣漏了一輪（issue #39）。`intake-routing` 已就同一理由把規則分了出去。
 * 3. 權限姿態不同：這份檔案僅擁有者可讀寫，偏好檔沒有這個要求。
 *
 * **也不與服務的連線設定共用一份。** 連線設定（workspace、要偵測的身分、回看範圍、端點）
 * 本來就要投影給 renderer（介面要顯示它們），機密放在同一個物件裡，那個投影就直接成了
 * 第一條出口。分成兩份之後，「把機密投影出去」需要先跨檔案去拿它 —— 那是一個做得到、
 * 但不會被不小心做出來的動作。
 *
 * ## 權限是「持有」而不是「建立時設定」
 *
 * `fs.writeFileSync` 的 `mode` **只在檔案被建立時生效**。三種情形會讓「建立時設定」靜默失效，
 * 而本模組逐一處置：
 *
 * - **目標檔已存在且權限較寬** —— `mode` 對它完全無效。處置：一律「寫暫存檔再更名」，
 *   `rename` 會用暫存檔的 inode（連同它的權限）取代目標。
 * - **暫存檔已存在且權限較寬** —— 前一次寫入中途崩潰就會留下一個。`mode` 對它同樣無效，
 *   而它的權限接著會被 `rename` **帶到目標檔上**。處置：寫完暫存檔後**明確 `chmod`**。
 *   （這一行看起來像防 umask 的，其實不是 —— **umask 只會清掉位元，不會加上**，
 *   所以 `mode: 0o600` 不可能因為 umask 而變寬。它防的是「暫存檔本來就在那裡」。
 *   第一版的註解把理由寫成 umask，而那條理由的對照組不會變紅。）
 *
 * 此外 `load()` 也會收緊權限 —— 檔案可能在兩次執行之間被外部改寬。
 *
 * > **作用域限於具備 POSIX 權限語意的平台。** Windows 上這些權限位元沒有意義，
 * > 該平台的等價保護視為**未涵蓋**，列為打包驗收前必須確認的項目（比照 `O_NOFOLLOW` 那條）。
 */

/** 設定檔的結構版本。比照 `preferences-store` / `workspace-store`。 */
export const SECRETS_VERSION = 1

/** 僅擁有者可讀寫。 */
const OWNER_ONLY = 0o600

/** 權限位元的遮罩 —— 只看使用者／群組／其他那九個位元，忽略 setuid 之類的高位。 */
const PERMISSION_BITS = 0o777

/** 字串化時吐出的東西。**不含機密的任何片段** —— 前綴與末幾碼同樣是片段。 */
const REDACTED = '[redacted]'

/**
 * 機密名稱的白名單。它會成為 JSON 的鍵，不會被拼進路徑，但仍然收斂 ——
 * 「不接受某個東西」由結構保證比由「沒有人再送它」保證強。
 */
const NAME_CHARSET = /^[a-z][a-z0-9.]{0,63}$/i

/**
 * 一份機密。**它的字串化形式不含內容**，而那是三個獨立的接縫，缺一不可：
 *
 * - `toString()` —— `String(s)`、`` `${s}` ``、字串相接。
 * - `toJSON()` —— `JSON.stringify(s)`，以及任何把設定物件整份序列化的診斷輸出。
 * - **`util.inspect.custom`** —— `console.log(s)` / `console.error(s)` 走的是 `util.inspect`，
 *   **不是 `toString`**。
 *
 * > **`#value` 是真正的 private field，而那本身就擋住了 `util.inspect`**（它看不見私有欄位，
 * > 只會吐 `Secret {}`）。所以 inspect.custom 提供的**不是**隱私，是**可讀的 redaction 標記**
 * > —— 診斷輸出裡出現 `[redacted]` 而不是一個空物件，讀 log 的人才知道那裡有一份機密被略過，
 * > 而不是以為那個欄位沒有值。第一版的註解把它寫成隱私的來源，而那條理由的對照組不會變紅。
 * > 如果 `#value` 日後被改成普通欄位，隱私就真的落在 inspect.custom 上了。
 *
 * 取用內容只有一個入口（`reveal()`），於是「誰真的用到了它」在原始碼中 grep 得出來。
 */
export class Secret {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  /** 取出內容。**唯一的入口** —— 呼叫它即宣告「這裡真的要用到明文」。 */
  reveal(): string {
    return this.#value
  }

  toString(): string {
    return REDACTED
  }

  toJSON(): string {
    return REDACTED
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED
  }
}

interface PersistedSecrets {
  version: number
  secrets: Record<string, string>
}

/**
 * 內容無法信任時回傳 `null`，由呼叫端隔離該檔並以「什麼都沒設定」啟動。
 *
 * **對結構嚴格，對個別項目寬容**（比照 `parsePreferences`）：version 不符或 `secrets` 不是物件
 * ⇒ 整檔不可信；但單一項目的名稱或值不合法時只忽略該項，不因一個壞值丟棄其餘憑證 ——
 * 那會讓使用者莫名地要把所有服務重新設定一次。
 */
export function parseSecrets(raw: string): PersistedSecrets | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const { version, secrets } = data as Record<string, unknown>
  if (version !== SECRETS_VERSION) return null
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) return null

  const parsed: Record<string, string> = {}
  for (const [name, value] of Object.entries(secrets as Record<string, unknown>)) {
    if (!NAME_CHARSET.test(name)) continue
    if (typeof value !== 'string' || value === '') continue
    parsed[name] = value
  }

  return { version: SECRETS_VERSION, secrets: parsed }
}

/**
 * 收緊一個既有檔案的權限。檔案不存在或平台不支援時靜默略過 ——
 * **權限收不緊不該讓應用程式開不起來**（那是最糟的失敗模式，比照偏好檔的損毀韌性）。
 */
function tightenPermissions(filePath: string): void {
  try {
    const current = fs.statSync(filePath).mode & PERMISSION_BITS
    if (current !== OWNER_ONLY) fs.chmodSync(filePath, OWNER_ONLY)
  } catch {
    // ENOENT（還沒有檔案）或平台不支援 —— 兩者都不是錯誤。
  }
}

/**
 * 寫出機密檔：暫存檔 → 收緊權限 → 更名。
 *
 * **順序是承重的。** 先更名再 `chmod`，目標檔就有一個真實存在、權限可能較寬的窗口；
 * 而只靠 `writeFileSync` 的 `mode` 則被 umask 遮罩（見檔頭）。
 */
export function writeSecretsFileAtomic(filePath: string, secrets: PersistedSecrets): void {
  const tmp = `${filePath}.tmp`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(secrets, null, 2)}\n`, {
    encoding: 'utf8',
    mode: OWNER_ONLY,
  })
  // **這一行防的是「暫存檔本來就在那裡」**（前一次寫入中途崩潰留下的）—— 那時上面的 `mode`
  // 完全無效，而它的寬權限接著會被 `rename` 帶到目標檔上。不是防 umask：umask 只清位元。
  tightenPermissions(tmp)
  // `rename` 以暫存檔的 inode（連同權限）取代目標，因此「目標檔原本權限較寬」也一併被處置。
  fs.renameSync(tmp, filePath)
}

function quarantine(filePath: string): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${filePath}.corrupt-${stamp}`
  try {
    fs.renameSync(filePath, target)
    return target
  } catch {
    return null
  }
}

/**
 * 機密的讀寫。**取用內容的唯一入口在 `Secret.reveal()`**，這個類別只回傳包裝過的值。
 *
 * 這個模組 SHALL NOT 被任何建構子行程環境的模組取用（`user-env` / `terminal` /
 * `report-runner`），且它與它的呼叫端 SHALL NOT 指派 `process.env` ——
 * `ptyEnv()` 展開 `process.env`，所以洩漏不需要經過那些模組。兩條皆由
 * `scripts/secret-scope.test.mjs` 守著。
 */
export class SecretStore {
  #secrets: Record<string, string> = {}

  constructor(private readonly filePath: string) {}

  /** 讀取。**任何讀取失敗都不得讓應用程式開不起來**（比照偏好與 workspace 的損毀隔離）。 */
  load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[secrets] store unreadable, starting with none: ${String(error)}`)
      }
      this.#secrets = {}
      return
    }

    // 檔案可能在兩次執行之間被外部改寬 —— 權限是「持有」而不是「建立時設定」。
    tightenPermissions(this.filePath)

    const parsed = parseSecrets(raw)
    if (!parsed) {
      const kept = quarantine(this.filePath)
      console.error(
        `[secrets] store unparsable, starting with none` +
          (kept ? `; the original was kept at ${kept}` : `; the original could not be kept`),
      )
      this.#secrets = {}
      return
    }

    this.#secrets = parsed.secrets
  }

  /** 有沒有設定某一份機密。**這是可以送給 renderer 的衍生事實** —— 機密本身不是。 */
  has(name: string): boolean {
    return this.#secrets[name] !== undefined
  }

  /** 已設定的機密名稱。同樣是衍生事實。 */
  names(): string[] {
    return Object.keys(this.#secrets).sort()
  }

  /** 取得一份機密（包裝過的）。未設定時回 `undefined`。 */
  get(name: string): Secret | undefined {
    const value = this.#secrets[name]
    return value === undefined ? undefined : new Secret(value)
  }

  /**
   * 設定一份機密。名稱不合法或值為空字串時**清除**該項 ——
   * 與偏好的 `null ＝清為預設` 同一條：「檔案壞了」與「使用者清掉了」不該是同一件事，
   * 而這裡沒有「預設值」可回，所以不合法即不存在。
   */
  set(name: string, value: string): void {
    if (!NAME_CHARSET.test(name)) return
    const next = { ...this.#secrets }
    if (value === '') delete next[name]
    else next[name] = value
    this.#commit(next)
  }

  /** 清除一份機密。 */
  clear(name: string): void {
    if (this.#secrets[name] === undefined) return
    const next = { ...this.#secrets }
    delete next[name]
    this.#commit(next)
  }

  /**
   * Writes `next`, **then** takes it. A write that throws leaves the secrets as they were: assigning first kept
   * a token that never reached the disk in memory, where it was used until the next start (`settings-sections`).
   */
  #commit(next: Record<string, string>): void {
    writeSecretsFileAtomic(this.filePath, { version: SECRETS_VERSION, secrets: next })
    this.#secrets = next
  }
}
