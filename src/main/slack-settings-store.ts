import fs from 'node:fs'
import path from 'node:path'

/**
 * Slack 連線設定的落盤與投影。**憑證不在這裡** —— 它住在 `secret-store.ts`。
 *
 * ## 為什麼與憑證分成兩份檔案
 *
 * 這一份**本來就要被投影給 renderer**（介面要顯示「已設定／未設定」、連到哪個工作區、
 * 端點是不是預設值、回看範圍多長）。憑證放在同一個物件裡，那個投影就直接成了
 * `secret-scope` 第一條 requirement 所防的那條出口。
 *
 * 分成兩份之後，「把憑證投影出去」需要先跨檔案去拿它 —— 那是一個做得到、但不會被不小心做出來
 * 的動作。（同一族的理由也讓它不與 `preferences.json` 共用：那個檔案的寫入路徑自空物件重建
 * 其內容，寄居其中的欄位倚賴每一個寫入者記得保留它 —— `agentStatus` 就是那樣漏了一輪。）
 *
 * ## 身分是**自憑證推導**的，不是設定出來的
 *
 * `teamId` 與 `selfUserId` 在這份檔案裡，但它們是 `auth.test` 的**快取**而非使用者設定 ——
 * 使用者設定不到它們，IPC 也不暴露它們的 setter。
 *
 * **這是刻意偏離第一版規格的地方，理由是失效模式**：一個由使用者填寫的「要偵測誰」填錯了，
 * 症狀是**什麼都不會發生** —— 與「沒有人 tag 我」、與「連線壞了」在畫面上完全相同，
 * 而那正是這個 change 一直在對付的那一類靜默失效。自憑證推導則**表達不出來填錯**：
 * user token 能看到的就是那個人看到的東西，`auth.test` 回的就是他自己。
 *
 * 規格的用意（「不是程式碼中的常數、不需要重新安裝」）完全保留 —— 推導比設定更強地滿足它。
 *
 * ## 欄位表與偏好同一個形狀
 *
 * 讀入、送往 renderer 兩條路徑自**單一欄位表**推導，漏一個欄位即編譯失敗。理由見
 * `preferences-store.ts` 的 `PREFERENCE_FIELDS`：那三處手寫清單讓 `agentStatus` 漏了一輪，
 * 而型別檢查對它零感知。這裡從第一天就不給那個缺陷存在的空間。
 */

/** 設定檔的結構版本。 */
export const SLACK_SETTINGS_VERSION = 1

/**
 * 端點的預設值。**非這個值時，介面必須標示**（見 `secret-scope` 的端點三條）——
 * 憑證的目的地是一個資料欄位，那個代價只有在使用者看得見時才可接受。
 */
export const DEFAULT_API_BASE_URL = 'https://slack.com/api'

/** 回看範圍的合理區間（天）。上界不是技術極限，是「啟動時的取回不該無界成長」。 */
const LOOKBACK_MIN_DAYS = 1
const LOOKBACK_MAX_DAYS = 30

/** 未設定時的回看範圍。 */
export const DEFAULT_LOOKBACK_DAYS = 7

/** Slack 的識別碼形狀（team / user / channel 皆為大寫英數）。 */
const SLACK_ID = /^[A-Z0-9]{1,32}$/

export interface SlackSettings {
  /** 自 `auth.test` 推導並快取 —— **不是使用者設定**。 */
  teamId?: string
  /** 同上。「要偵測誰被 tag」的答案就是憑證的擁有者。 */
  selfUserId?: string
  lookbackDays?: number
  /** 端點。未設定即 `DEFAULT_API_BASE_URL`。 */
  apiBaseUrl?: string
}

interface PersistedSlackSettings {
  version: number
  slack: SlackSettings
}

function sanitizeSlackId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return SLACK_ID.test(value) ? value : undefined
}

function clampLookbackDays(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(LOOKBACK_MAX_DAYS, Math.max(LOOKBACK_MIN_DAYS, Math.round(value)))
}

/**
 * 端點的清理：**scheme 白名單，只認 `https:`**。
 *
 * 白名單而非黑名單，理由與 intake 的正規化同一條：「排除不安全的 scheme」是一個列舉不完的集合
 * （`http:`、`file:`、`data:`、`javascript:`…），漏掉任何一個都不會有東西變紅。
 *
 * **不合法即回未設定（＝退回預設端點），不是「原樣接受」也不是「整檔不可信」。**
 * 憑證的目的地是這條管線上最不該接受可疑值的欄位。
 */
export function sanitizeApiBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  // 尾斜線正規化，於是「同一個端點的兩種寫法」不會在介面上呈現為兩個不同的值。
  return url.href.replace(/\/+$/, '')
}

/** 一個設定欄位必須回答的兩件事。**沒有預設值** —— 理由見 `preferences-store` 的同名介面。 */
interface FieldSpec<T> {
  /** 回傳型別與欄位的值型別**相繫** —— 接錯欄位即型別錯誤（見 `preferences-store` 的 D9）。 */
  sanitize: (value: unknown) => T | undefined
  /** 送往 renderer 嗎？ */
  toRenderer: boolean
}

/**
 * 連線設定的**單一來源**。
 *
 * `toRenderer` 全為 `true`：這四個欄位**都是**介面要顯示的東西（連到哪個工作區、以誰的身分、
 * 回看多久、端點是不是預設）。**而憑證不在這張表上** —— 它不在這個物件裡，
 * 由 `scripts/secret-scope.test.mjs` 的守衛②釘住（本模組不得取用機密模組）。
 */
const SLACK_FIELDS = {
  teamId: { sanitize: sanitizeSlackId, toRenderer: true },
  selfUserId: { sanitize: sanitizeSlackId, toRenderer: true },
  lookbackDays: { sanitize: clampLookbackDays, toRenderer: true },
  apiBaseUrl: { sanitize: sanitizeApiBaseUrl, toRenderer: true },
} satisfies {
  [K in keyof Required<SlackSettings>]: FieldSpec<Required<SlackSettings>[K]>
}

type SlackField = keyof typeof SLACK_FIELDS

const SLACK_KEYS = Object.keys(SLACK_FIELDS) as SlackField[]

/** 送往 renderer 的欄位，自 `toRenderer` 反推 —— 窄化必須抵達 renderer，見 preload 的說明。 */
type RendererField = {
  [K in SlackField]: (typeof SLACK_FIELDS)[K]['toRenderer'] extends true ? K : never
}[SlackField]

export type ProjectedSlackSettings = Pick<SlackSettings, RendererField>

/** 見 `preferences-store` 的 `assignField` —— 唯一需要放寬型別的地方，且放寬是安全的。 */
function assignField(target: SlackSettings, key: SlackField, value: unknown): void {
  if (value === undefined) return
  ;(target as Record<string, unknown>)[key] = value
}

/**
 * 送往 renderer 的投影：**逐欄位白名單**，且保持「未設定即省略」。
 *
 * **不可改回原樣轉手。** 這個物件與憑證是鄰居（同一個功能、相鄰的檔案），而它**本來就要
 * 送出去** —— 那使它成為機密最可能搭便車的那條路。這條由
 * `scripts/settings-projection.test.mjs` 守著（它與 `settings:get` 是**兩個不同的處理常式**，
 * 那道守衛因此必須同時涵蓋兩者）。
 */
export function projectSlackSettings(settings: SlackSettings): ProjectedSlackSettings {
  const projected: SlackSettings = {}
  for (const key of SLACK_KEYS) {
    if (!SLACK_FIELDS[key].toRenderer) continue
    assignField(projected, key, settings[key])
  }
  return projected
}

/**
 * 內容無法信任時回 `null`。**對結構嚴格，對個別欄位寬容**（比照 `parsePreferences`）：
 * 形狀不合的單一欄位被忽略，SHALL NOT 使其餘欄位失效 —— 否則一個壞掉的端點會讓使用者
 * 連「我連到哪個工作區」都看不到。
 */
export function parseSlackSettings(raw: string): PersistedSlackSettings | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const { version, slack } = data as Record<string, unknown>
  if (version !== SLACK_SETTINGS_VERSION) return null
  if (typeof slack !== 'object' || slack === null || Array.isArray(slack)) return null

  const source = slack as Record<string, unknown>
  const parsed: SlackSettings = {}
  for (const key of SLACK_KEYS) {
    assignField(parsed, key, SLACK_FIELDS[key].sanitize(source[key]))
  }

  return { version: SLACK_SETTINGS_VERSION, slack: parsed }
}

export function writeSlackSettingsFileAtomic(
  filePath: string,
  settings: PersistedSlackSettings,
): void {
  const tmp = `${filePath}.tmp`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
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

/** An endpoint the user entered that is not an acceptable `https:` address (see `sanitizeApiBaseUrl`). */
export class InvalidEndpointError extends Error {
  constructor() {
    super('The Slack API endpoint must be an https address')
    this.name = 'InvalidEndpointError'
  }
}

export class SlackSettingsStore {
  #settings: SlackSettings = {}

  constructor(private readonly filePath: string) {}

  /** **任何讀取失敗都不得讓應用程式開不起來**（比照偏好與 workspace 的損毀隔離）。 */
  load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[slack] settings unreadable, starting with defaults: ${String(error)}`)
      }
      this.#settings = {}
      return
    }

    const parsed = parseSlackSettings(raw)
    if (!parsed) {
      const kept = quarantine(this.filePath)
      console.error(
        `[slack] settings unparsable, starting with defaults` +
          (kept ? `; the original was kept at ${kept}` : `; the original could not be kept`),
      )
      this.#settings = {}
      return
    }

    this.#settings = parsed.slack
  }

  get(): SlackSettings {
    return { ...this.#settings }
  }

  /** 回看範圍，已套用預設。 */
  lookbackDays(): number {
    return this.#settings.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
  }

  /** 端點，已套用預設。 */
  apiBaseUrl(): string {
    return this.#settings.apiBaseUrl ?? DEFAULT_API_BASE_URL
  }

  /** 端點是不是預設值 —— **介面要據此標示**（`secret-scope` 的端點第二條）。 */
  usesDefaultEndpoint(): boolean {
    return this.#settings.apiBaseUrl === undefined
  }

  /**
   * 使用者明確設定回看範圍。`null` ＝清為預設。
   *
   * 每個 setter 各自一個方法（而不是一個吃整份物件的 `update()`），理由與
   * `preferences-store` 把 GPU 與字型分開同一條：一個吃整份的 setter 會讓 renderer
   * 有能力一次改掉端點 —— 而端點的變更必須是一個**指名它**的動作。
   */
  setLookbackDays(days: number | null): SlackSettings {
    const next = { ...this.#settings }
    const value = days === null ? undefined : clampLookbackDays(days)
    if (value === undefined) delete next.lookbackDays
    else next.lookbackDays = value
    this.#commit(next)
    return this.get()
  }

  /**
   * 使用者明確設定端點。`null`／不合法 ＝清為預設。
   *
   * **這是端點唯一的寫入點**（`secret-scope` 的端點第一條：只能由使用者明確操作改動）——
   * 它不從環境變數讀、不從投遞內容讀、不從 routing 規則讀。
   */
  setApiBaseUrl(url: string | null): SlackSettings {
    const next = { ...this.#settings }
    const value = url === null ? undefined : sanitizeApiBaseUrl(url)
    // **An edit that fails the check is refused, not turned into the default.** Turning it into the default
    // erased the user's custom endpoint over a typo and said nothing. A stored value read back by `load()`
    // still means the default when it fails the check: that is damaged data, not an edit.
    if (url !== null && value === undefined) throw new InvalidEndpointError()
    if (value === undefined) delete next.apiBaseUrl
    else next.apiBaseUrl = value
    this.#commit(next)
    return this.get()
  }

  /**
   * 記下自 `auth.test` 推導出的身分。**這不是使用者設定** —— 沒有對應的 IPC setter，
   * 呼叫端只有連線那一層。兩者皆不合法時視為「還沒連上」，清掉快取。
   */
  rememberIdentity(teamId: string, selfUserId: string): void {
    const team = sanitizeSlackId(teamId)
    const self = sanitizeSlackId(selfUserId)
    const next = { ...this.#settings }
    if (team === undefined) delete next.teamId
    else next.teamId = team
    if (self === undefined) delete next.selfUserId
    else next.selfUserId = self
    this.#commit(next)
  }

  /** Writes `next`, **then** takes it: a write that throws leaves the settings as they were. */
  #commit(next: SlackSettings): void {
    writeSlackSettingsFileAtomic(this.filePath, { version: SLACK_SETTINGS_VERSION, slack: next })
    this.#settings = next
  }
}
