import fs from 'node:fs'
import path from 'node:path'

import { type Language, isSupportedLanguage } from '@shared/i18n/languages'

/**
 * 偏好設定檔的結構版本。從第一天就寫入 —— 沒有版本欄位的舊檔日後無法安全遷移。
 * 比照 `workspace-store` / `session-store`。
 */
export const PREFERENCES_VERSION = 1

/** 終端外觀偏好。未設定的欄位一律省略 —— 空偏好＝全部用預設（系統字型 / 字級尺度 / 預設行高）。 */
export interface TerminalPreferences {
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  /**
   * GPU 加速（＝ webgl renderer）。**未設定＝啟用** —— 省略即預設，與其他欄位同一條規則。
   *
   * 它是**逃生口**：終端已有自動降級（渲染資源取不到或執行期失效時退回），但那只擋得住
   * 「取不到」；擋不住「取得了、但驅動有缺陷而畫出錯的內容」—— 那不觸發任何事件，只有使用者
   * 看得出來，也只有使用者關得掉。
   */
  gpuAcceleration?: boolean
  /**
   * 與 agent 的狀態橋接（見 `agent-status.ts`）。**未設定＝啟用** —— 與 `gpuAcceleration` 同一條
   * 規則。預設啟用的前提是實測的零損失：未自訂 statusline 的使用者，那個位置本來就是空的
   * （agent 內建的模式提示行**不是** statusLine）。保留這個開關，是給不希望 spekterm 改變
   * agent 呼叫方式的使用者一條退路 —— 那是本能力唯一會改變 spekterm 之外行為的部分。
   */
  agentStatus?: boolean
  /**
   * 與 agent 的事件橋接（見 `agent-events.ts`）。**未設定＝啟用**，與上面同一條規則。
   *
   * **它與 `agentStatus` 是兩個獨立的開關，這是規格條款而不是方便**：兩者共用同一個注入接縫，
   * 但關掉狀態列 SHALL NOT 連帶關掉對話 view 的輸入能力。捆在一起的實作不會有任何型別錯誤。
   */
  agentEvents?: boolean
  /**
   * agent session 以哪一種 view 呈現（`agent-conversation-view`）。**未設定＝終端**。
   *
   * **它是全域的，不是 per-session** —— 使用者同時開著數個 agent session 時從不希望它們不一樣，
   * 而「一邊以對話 view 看 agent、一邊以終端 view 用 shell」這個曾經的理由不成立：
   * shell 目標根本不具備對話 view（那由 spawn 目標的判定保障，與這個偏好無關）。
   *
   * **名字上它不是「終端」偏好**，這個張力是真的 —— 但 `agentStatus` / `agentEvents` 已經
   * 住在這裡，先例在。**不要順手把這個區塊改名**：`parsePreferences` 在 `version` 不符時
   * 隔離整檔，一次版本遞增等於每個使用者的字型設定歸零。
   */
    agentView?: 'terminal' | 'conversation'
  /**
   * How long a running session may sit idle before it is hibernated (`session-hibernation`), in
   * seconds. **Unset = 24 hours; `0` = off.**
   *
   * Off is `0`, not `null`: this store's setters already use `null` to mean "reset to default", and
   * turning the feature off must persist as off — a missing value means the default, which is on.
   * Any non-negative whole number is accepted, not only the values Settings offers, so a probe can
   * seed a threshold of seconds without a test branch in product code.
   */
  autoHibernateSeconds?: number
}

/**
 * 與終端無關的應用程式偏好。
 *
 * **它是一個與 `terminal` 並列的區塊，而不是塞進 `TerminalPreferences` 的一個欄位** ——
 * 語言不是終端的偏好，而一個開始說謊的區塊名會讓下一個非終端偏好沿著同一條路再塞一個。
 *
 * **加入這個區塊 SHALL NOT 遞增 `PREFERENCES_VERSION`**：版本不符時 `parsePreferences`
 * 隔離整檔，一次遞增等於每個使用者既有的字型設定歸零。舊檔沒有 `ui` ⇒ 該區塊為空。
 */
export interface UiPreferences {
  /** UI 語言。**未設定＝英文** —— 而「未設定」同時是「首次啟動時要不要偵測」的判準之一。 */
  language?: Language
}

interface PersistedPreferences {
  version: number
  terminal: TerminalPreferences
  ui: UiPreferences
}

/**
 * 字型大小的合理範圍。偏好走 JS 設定 `xterm.fontSize`（數字），這裡夾制於一個「還讀得到終端」
 * 的範圍 —— 太小看不見、太大一行放不了幾個字。
 */
const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32
/** 字型 family 名的長度上限。單一字型名不該長成這樣，超過即截斷。 */
const FONT_FAMILY_MAX_LENGTH = 100
/**
 * 行高的合理範圍。1 以下會讓字互相重疊；2 以上一個畫面放不了幾行。
 *
 * **行高不只是可讀性**：終端的框線字元靠字型的 glyph 去拼，而 glyph 只有約 1em 高 —— 行高越大，
 * 上下列的 `│` 之間縫越明顯，表格越容易看起來是破的（見 `xterm.ts` 的 `DEFAULT_LINE_HEIGHT`）。
 */
const LINE_HEIGHT_MIN = 1
const LINE_HEIGHT_MAX = 2

/**
 * 字型 family 的清理。**去除控制字元與雙引號，但保留空白**（`MesloLGS NF` 這種含空白的字型名
 * 要留著）。family 會被拼進 xterm 的 CSS font-family 字串並以雙引號包住（見 `xterm.ts` 的
 * `resolveFamily`）—— 一個內嵌的 `"` 會破壞那個字串。空字串（清理後）視為未設定。
 *
 * 以 char code 過濾而非 regex 字元類別 —— 控制字元寫進 regex literal 會在原始碼裡變成看不見的
 * 位元組，難以審閱與比對。
 */
function sanitizeFamily(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = [...value]
    .filter((ch) => ch !== '"' && ch.charCodeAt(0) >= 0x20)
    .join('')
    .trim()
  if (cleaned === '') return undefined
  return cleaned.slice(0, FONT_FAMILY_MAX_LENGTH)
}

/** 字型大小的夾制。非有限數視為未設定；否則四捨五入並夾於範圍內。 */
function clampSize(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)))
}

/** 行高的夾制。非有限數視為未設定；否則夾於範圍內並取到小數兩位（行高是分數，不取整）。 */
function clampLineHeight(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const clamped = Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, value))
  return Math.round(clamped * 100) / 100
}

/**
 * view 的白名單判定：**恰為那兩個字面值之一才採用**，其餘一律視為未設定。
 *
 * **不可寫成 `value === 'conversation' ? … : 'terminal'`** —— 那會把「檔案壞了」與
 * 「使用者選了終端」變成同一件事。前者的正確處置是回到未設定，讓「未設定＝終端」那條規則
 * 去決定，於是只有一個地方在決定。同 `gpuAcceleration` 那條「只認真正的布林」。
 */
function sanitizeAgentView(value: unknown): 'terminal' | 'conversation' | undefined {
  return value === 'terminal' || value === 'conversation' ? value : undefined
}

/**
 * 布林偏好的清理：**只認真正的布林**，其餘一律視為未設定。
 *
 * 與 `sanitizeAgentView` 同一條理由 —— 檔案裡的 `"false"` / `0` 之類的東西不硬轉成 `false`，
 * 因為「檔案壞了」與「使用者關掉了」不是同一件事。前者的正確處置是回到未設定，
 * 讓「未設定＝啟用」那條規則去決定，於是只有一個地方在決定。
 */
function sanitizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Auto-hibernation threshold: a non-negative whole number of seconds, anything else is unset. */
function sanitizeHibernateSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * 語言的清理器：**白名單查表**，不在受支援清單中即視為未設定。
 *
 * 與 `sanitizeAgentView` 同一條理由 —— 「檔案壞了」與「使用者選了英文」不是同一件事。
 * 前者的正確處置是回到未設定，讓「未設定＝英文」那條規則去決定，於是只有一個地方在決定。
 */
function sanitizeLanguage(value: unknown): Language | undefined {
  return isSupportedLanguage(value) ? value : undefined
}

/** 一個偏好欄位必須回答的兩件事。**沒有任何一個有預設值** —— 見 `PREFERENCE_FIELDS`。 */
interface FieldSpec<T> {
  /**
   * 不受信任的值 → 該欄位的值，或未設定。
   *
   * **回傳型別與欄位的值型別相繫，這是承重的**：若這裡寫成 `(value: unknown) => unknown`，
   * 把 `fontFamily` 接上 `clampSize` 就不再是型別錯誤 —— 那會用一個新的靜默失效
   * （表是單一來源，但每一格接錯無人知）換掉舊的那個。
   */
  sanitize: (value: unknown) => T | undefined
  /** 送往 renderer 嗎？ */
  toRenderer: boolean
}

/**
 * 終端偏好額外要回答的一件事。
 *
 * **群組的概念只屬於終端這個區塊** —— `setTerminalFont` 自空物件重建它時需要分辨哪些欄位
 * 由參數決定。把它提到共用的 `FieldSpec` 上，等於要求每一個新區塊都回答一個與它無關的問題。
 */
interface TerminalFieldSpec<T> extends FieldSpec<T> {
  /**
   * 屬於字型群組嗎？`setTerminalFont` 自空物件重建 `terminal` 時，**只有字型群組的欄位由參數
   * 決定，其餘一律自當前偏好保留**。
   */
  group: 'font' | 'other'
}

/**
 * 偏好欄位的**單一來源**。三條路徑全部自這裡推導：自磁碟讀入（`parsePreferences`）、
 * 部分更新時的保留（`setTerminalFont`）、送往 renderer（`projectPreferences`）。
 *
 * ## 它取代的是一條已經失效過的紀律
 *
 * 那三處此前是三份各自維護的清單，而**型別檢查對它們零感知**：漏在讀入清單中的欄位寫得進
 * 磁碟卻讀不回來（症狀是「這個偏好不跨重啟」），漏在保留清單中的欄位會在使用者改一次字型時
 * 被抹掉（症狀是「這個開關會自己彈回去」）。**兩種失效都沒有任何東西會變紅，而 `agentStatus`
 * 兩處都漏了**（issue #39）。
 *
 * `satisfies` 使三件事成為編譯錯誤：少一個欄位、某欄位漏答一個問題、多一個型別上不存在的欄位。
 *
 * > **不要把型別改寫成 `Record<keyof TerminalPreferences, FieldSpec>`。** 它讀起來等價，
 * > 但 `Record` 的鍵型別受限於 `keyof any` 而非 `keyof T`，於是它不是 homomorphic mapped
 * > type，`FieldSpec` 也就拿不到逐欄位的 `T` —— 清理器接到錯的欄位上**零錯誤**。
 *
 * ## 三個答案都必須被明確作答
 *
 * 特別是 `toRenderer`：一個沉默的預設會讓下一個機密欄位靜默地流到 renderer，
 * 而 renderer 渲染的是不受信任的內容。**`agentEvents` 是 `false`，因為 renderer 從不讀它**
 * （只有主行程的注入路徑讀）—— 這不是保守起見，是它真的不需要。
 */
const PREFERENCE_FIELDS = {
  fontFamily: { sanitize: sanitizeFamily, group: 'font', toRenderer: true },
  fontSize: { sanitize: clampSize, group: 'font', toRenderer: true },
  lineHeight: { sanitize: clampLineHeight, group: 'font', toRenderer: true },
  gpuAcceleration: { sanitize: sanitizeBoolean, group: 'other', toRenderer: true },
  agentStatus: { sanitize: sanitizeBoolean, group: 'other', toRenderer: true },
  agentEvents: { sanitize: sanitizeBoolean, group: 'other', toRenderer: false },
    agentView: { sanitize: sanitizeAgentView, group: 'other', toRenderer: true },
  autoHibernateSeconds: { sanitize: sanitizeHibernateSeconds, group: 'other', toRenderer: true },
} satisfies {
  [K in keyof Required<TerminalPreferences>]: TerminalFieldSpec<Required<TerminalPreferences>[K]>
}

/**
 * UI 偏好的**單一來源**，與 `PREFERENCE_FIELDS` 平行。
 *
 * **兩張表刻意不併成一張。** 併成一張 `Record<string, FieldSpec>` 讀起來等價，但 `Record`
 * 的鍵型別是 `keyof any` 而非 `keyof T`，於是它不是 homomorphic mapped type，`FieldSpec`
 * 拿不到逐欄位的 `T` —— **把清理器接到錯的欄位上就不再是型別錯誤**。那個逐欄位的繫結正是
 * 這張表擋得住「漏一個欄位」的原因（issue #39），不能為了容納新區塊而鬆掉。
 */
const UI_PREFERENCE_FIELDS = {
  language: { sanitize: sanitizeLanguage, toRenderer: true },
} satisfies {
  [K in keyof Required<UiPreferences>]: FieldSpec<Required<UiPreferences>[K]>
}

type UiPreferenceKey = keyof typeof UI_PREFERENCE_FIELDS

const UI_PREFERENCE_KEYS = Object.keys(UI_PREFERENCE_FIELDS) as UiPreferenceKey[]

type PreferenceKey = keyof typeof PREFERENCE_FIELDS

/**
 * 字型群組的欄位，**自 `PREFERENCE_FIELDS` 的 `group` 反推**。
 *
 * 它讓 `setTerminalFont` 的參數組在型別上完整：往表裡新增一個 `group: 'font'` 的欄位時，
 * 那個方法裡的參數物件會少一個鍵而**編譯失敗**。少了這層，新欄位會落進「不由參數決定、
 * 也不被保留」的縫裡 —— 每改一次字型就被清掉一次。
 */
type FontField = {
  [K in PreferenceKey]: (typeof PREFERENCE_FIELDS)[K]['group'] extends 'font' ? K : never
}[PreferenceKey]

const PREFERENCE_KEYS = Object.keys(PREFERENCE_FIELDS) as PreferenceKey[]

/**
 * 把一個欄位寫進偏好物件（未設定則不寫 —— 「未設定即省略」）。
 *
 * **這是唯一需要放寬型別的地方，而放寬是安全的**：`PREFERENCE_FIELDS` 已經在型別上把每個
 * 欄位的清理器與該欄位的值型別繫在一起，這裡只是把「走訪一個物件時失去的鍵—值關聯」補回來。
 */
function assignField(
  target: TerminalPreferences & UiPreferences,
  key: PreferenceKey | UiPreferenceKey,
  value: unknown,
): void {
  if (value === undefined) return
  ;(target as Record<string, unknown>)[key] = value
}

/** 送往 renderer 的欄位，**自 `PREFERENCE_FIELDS` 的 `toRenderer` 反推**。 */
type RendererField = {
  [K in PreferenceKey]: (typeof PREFERENCE_FIELDS)[K]['toRenderer'] extends true ? K : never
}[PreferenceKey]

/**
 * renderer 看得到的偏好。**它是一個比 `TerminalPreferences` 窄的型別**，而那道窄化是承重的：
 * renderer 讀一個未宣告要送出的欄位是**編譯錯誤**，不是一個在執行期恰好是 `undefined` 的值。
 *
 * 執行期的白名單擋得住「欄位被送出去」，擋不住「有人寫了讀它的程式碼、而它永遠是 undefined」
 * —— 後者的症狀是一個安靜地永遠走 else 分支的判斷。
 */
type UiRendererField = {
  [K in UiPreferenceKey]: (typeof UI_PREFERENCE_FIELDS)[K]['toRenderer'] extends true ? K : never
}[UiPreferenceKey]

export type ProjectedPreferences = Pick<TerminalPreferences, RendererField> &
  Pick<UiPreferences, UiRendererField>

/**
 * 送往 renderer 的投影：**逐欄位白名單**，且保持「未設定即省略」。
 *
 * **不可改回原樣轉手整個物件。** 那樣的話，任何日後加進偏好的欄位 —— 包含機密 ——
 * 都會零改動、零紅燈地送到 renderer。這條由 `scripts/settings-projection.test.mjs` 守著。
 *
 * **五個 IPC 處理常式都要經過這裡，不只 `settings:get`** —— 四個 setter 同樣把套用後的偏好
 * 回傳給 renderer，漏掉任一個，那條路就是一個沒有白名單的出口。
 *
 * 「未設定即省略」不是風格：`probe:workspace` 有一條以「空偏好的鍵數為 0」為判準的斷言，
 * 把未設定欄位寫成 `undefined` 會讓它當場變紅。
 */
export function projectPreferences(
  preferences: TerminalPreferences,
  ui: UiPreferences,
): ProjectedPreferences {
  const projected: TerminalPreferences & UiPreferences = {}
  for (const key of PREFERENCE_KEYS) {
    if (!PREFERENCE_FIELDS[key].toRenderer) continue
    assignField(projected, key, preferences[key])
  }
  for (const key of UI_PREFERENCE_KEYS) {
    if (!UI_PREFERENCE_FIELDS[key].toRenderer) continue
    assignField(projected, key, ui[key])
  }
  return projected
}

/**
 * 內容無法信任時一律回傳 `null`，由呼叫端隔離該檔並以預設偏好啟動。
 *
 * **對結構嚴格，對值寬容**：version 不符、`terminal` 不是物件 → `null`（整檔不可信，隔離）；
 * 但個別欄位（family／size）不合法時只是清理／夾制成預設，不因一個壞值就丟棄整份偏好。
 */
export function parsePreferences(raw: string): PersistedPreferences | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof data !== 'object' || data === null) return null
  const { version, terminal, ui } = data as Record<string, unknown>

  if (version !== PREFERENCES_VERSION) return null
  if (typeof terminal !== 'object' || terminal === null) return null
  // **`ui` 缺席是合法的**（本區塊加入之前寫下的檔案就沒有它），但**存在而形狀不對就是整檔
  // 不可信** —— 與 `terminal` 同一條規則。缺席與壞掉是兩件事，不可混為一談：把後者也當成
  // 「沒設定」會讓一份被外部程式改壞的檔案靜默地以預設繼續，而使用者的其餘偏好也一併失效。
  if (ui !== undefined && (typeof ui !== 'object' || ui === null)) return null

  // 讀入的白名單**自 `PREFERENCE_FIELDS` 推導**，不是一份手寫的解構清單。此前它是手寫的，
  // 而型別檢查對它零感知 —— 漏在那裡的欄位寫得進磁碟卻讀不回來，症狀是「這個偏好不跨重啟」，
  // 而沒有任何東西會紅（`agentStatus` 就是這樣漏了一輪，見 issue #39）。
  const source = terminal as Record<string, unknown>
  const parsed: TerminalPreferences = {}
  for (const key of PREFERENCE_KEYS) {
    assignField(parsed, key, PREFERENCE_FIELDS[key].sanitize(source[key]))
  }

  const uiSource = (ui ?? {}) as Record<string, unknown>
  const parsedUi: UiPreferences = {}
  for (const key of UI_PREFERENCE_KEYS) {
    assignField(parsedUi, key, UI_PREFERENCE_FIELDS[key].sanitize(uiSource[key]))
  }

  return { version: PREFERENCES_VERSION, terminal: parsed, ui: parsedUi }
}

/**
 * 先寫暫存檔再更名。同一個檔案系統上 `rename` 是原子的，因此中途失敗只會留下
 * 舊內容或新內容，不會留下半截 JSON。比照 `workspace-store`。
 */
export function writePreferencesFileAtomic(
  filePath: string,
  preferences: PersistedPreferences,
): void {
  const tmp = `${filePath}.tmp`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8')
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

export class PreferencesStore {
  private preferences: TerminalPreferences = {}
  private uiPreferences: UiPreferences = {}
  /**
   * 這次啟動時，磁碟上**原本有沒有**偏好檔。
   *
   * **它不是「`ui.language` 有沒有設定」的同義詞，而首次啟動的語言偵測正是以它為判準。**
   * 以欄位未設定為判準的話，既有使用者升級之後 app 會自己變成他作業系統的語言 ——
   * 一次沒有人要求過的行為改變。
   */
  private existedOnLoad = false

  constructor(private readonly filePath: string) {}

  /**
   * 讀取偏好。**任何讀取失敗都不得讓應用程式開不起來** —— 那是最糟的失敗模式。
   * 無法信任的檔案改名保留（不刪除），以預設偏好繼續。比照 `workspace-store`。
   */
  load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      if (!missing) {
        console.error(`[preferences] config unreadable, starting with defaults: ${String(error)}`)
      }
      // 讀不到但**不是**因為它不存在（權限、I/O）—— 檔案仍在磁碟上，因此這不是首次啟動。
      this.existedOnLoad = !missing
      this.preferences = {}
      this.uiPreferences = {}
      return
    }

    this.existedOnLoad = true

    const parsed = parsePreferences(raw)
    if (!parsed) {
      const kept = quarantine(this.filePath)
      console.error(
        `[preferences] config unparsable, starting with defaults` +
          (kept ? `; the original was kept at ${kept}` : `; the original could not be kept`),
      )
      this.preferences = {}
      this.uiPreferences = {}
      // **隔離之後立刻回寫一份預設檔。** 隔離是把原檔改名保留，於是**檔案就不存在了** ——
      // 而「偏好檔不存在」是首次啟動語言偵測的判準。少了這次回寫，一個曾經壞過一次偏好檔的
      // 使用者，會在下一次啟動時莫名其妙換了語言，而他從來沒有動過語言設定。
      this.save()
      return
    }

    this.preferences = parsed.terminal
    this.uiPreferences = parsed.ui
  }

  /**
   * 這次啟動之前，偏好檔存不存在。
   *
   * **「不存在」嚴格等同於「從未啟動過」** —— 隔離路徑會立刻回寫一份預設檔來維持這個等式
   *（見 `load()`）。少了那次回寫，「偏好檔壞過一次」的使用者會在下一次啟動時莫名其妙換了語言。
   */
  existed(): boolean {
    return this.existedOnLoad
  }

  /** 當前的 UI 偏好（複本）。 */
  ui(): UiPreferences {
    return { ...this.uiPreferences }
  }

  /**
   * 設定 UI 語言。`null` ＝清為預設（＝英文）。
   *
   * **回傳整個 `ui` 區塊而非整份偏好** —— 呼叫端要把它交給投影，而投影逐區塊白名單。
   */
  setLanguage(language: Language | null): UiPreferences {
    const next: UiPreferences = { ...this.uiPreferences }
    const sanitized = language === null ? undefined : sanitizeLanguage(language)
    if (sanitized === undefined) delete next.language
    else next.language = sanitized

    this.commit({ ui: next })
    return this.ui()
  }

  /** 當前的終端偏好（複本）。 */
  get(): TerminalPreferences {
    return { ...this.preferences }
  }

  /**
   * 設定終端字型偏好（family／size／lineHeight 一起 —— 設定介面的欄位同時送）。
   *
   * 傳 `null`／不合法值即清為預設（該欄不占空間）。回傳套用後的偏好，供 renderer 立即使用。
   */
  setTerminalFont(
    fontFamily: string | null,
    fontSize: number | null,
    lineHeight: number | null,
  ): TerminalPreferences {
    // 字型群組的參數組。**它的型別自 `PREFERENCE_FIELDS` 的 `group` 反推** —— 往表裡新增一個
    // `group: 'font'` 的欄位時，這個物件會少一個鍵而編譯失敗，於是新欄位不會落進
    // 「不由參數決定、也不被保留」的縫裡（那條縫的症狀是每改一次字型就被清掉一次）。
    const incoming: { [K in FontField]: TerminalPreferences[K] | null } = {
      fontFamily,
      fontSize,
      lineHeight,
    }

    const next: TerminalPreferences = {}
    for (const key of PREFERENCE_KEYS) {
      const spec = PREFERENCE_FIELDS[key]
      if (spec.group === 'font') {
        // `null` ＝明確清為預設；不合法的值由清理器退回未設定。
        const raw = incoming[key as FontField]
        assignField(next, key, raw === null ? undefined : spec.sanitize(raw))
        continue
      }
      // **非字型的偏好一律自當前值保留 —— 這個方法只管字型。**
      // 此前這裡是三行手寫的保留，而漏一行的症狀是靜默的：使用者關掉了 GPU（因為驅動有問題、
      // 畫面是壞的），接著調一下字級，GPU 就自己開回來了 —— 而那正是他關掉它的原因。
      // 改為自表推導之後，「忘記保留新欄位」表達不出來。
      assignField(next, key, this.preferences[key])
    }

    this.commit({ terminal: next })
    return this.get()
  }

  /**
   * 開／關 GPU 加速。`null` ＝清為預設（＝啟用）。
   *
   * 與 `setTerminalFont` 分開，是因為它**不是字型偏好** —— 把它塞進那個方法的第四個參數，
   * 方法名就開始說謊。字型偏好不受此方法影響（反之亦然，見 `setTerminalFont` 的保留邏輯）。
   */
  setGpuAcceleration(enabled: boolean | null): TerminalPreferences {
    const next: TerminalPreferences = { ...this.preferences }
    if (enabled === null) delete next.gpuAcceleration
    else next.gpuAcceleration = enabled

    this.commit({ terminal: next })
    return this.get()
  }

  /** 與 agent 的狀態橋接。`null` ＝ 清除（回到預設的啟用）。 */
  setAgentStatus(enabled: boolean | null): TerminalPreferences {
    const next: TerminalPreferences = { ...this.preferences }
    if (enabled === null) delete next.agentStatus
    else next.agentStatus = enabled

    this.commit({ terminal: next })
    return this.get()
  }

  /** agent session 的呈現方式。`null` ＝ 清除（回到預設的終端）。 */
  setAgentView(view: 'terminal' | 'conversation' | null): TerminalPreferences {
    const next: TerminalPreferences = { ...this.preferences }
    const sanitized = view === null ? undefined : sanitizeAgentView(view)
    if (sanitized === undefined) delete next.agentView
    else next.agentView = sanitized

    this.commit({ terminal: next })
    return this.get()
  }

    /**
   * Automatic hibernation threshold in seconds; `0` = off. `null` or an invalid value = reset to the
   * default (24 hours).
   */
  setAutoHibernate(seconds: number | null): TerminalPreferences {
    const next: TerminalPreferences = { ...this.preferences }
    const sanitized = seconds === null ? undefined : sanitizeHibernateSeconds(seconds)
    if (sanitized === undefined) delete next.autoHibernateSeconds
    else next.autoHibernateSeconds = sanitized

    this.commit({ terminal: next })
    return this.get()
  }

  /**
   * Writes the next state, **then** takes it. A write that throws leaves the state as it was: assigning first
   * kept a value that never reached the disk in memory, where `get()` reported it and the next successful
   * write of any field stored it (`terminal-preferences`, "A change in Settings applies when it is made").
   */
  private commit(next: { terminal?: TerminalPreferences; ui?: UiPreferences }): void {
    const terminal = next.terminal ?? this.preferences
    const ui = next.ui ?? this.uiPreferences
    writePreferencesFileAtomic(this.filePath, { version: PREFERENCES_VERSION, terminal, ui })
    this.existedOnLoad = true
    this.preferences = terminal
    this.uiPreferences = ui
  }

  private save(): void {
    writePreferencesFileAtomic(this.filePath, {
      version: PREFERENCES_VERSION,
      terminal: this.preferences,
      ui: this.uiPreferences,
    })
    this.existedOnLoad = true
  }
}
