/**
 * 一則 intake 的欄位分組與解析。
 *
 * ## 三組欄位，而分組落在型別上
 *
 * - **`verified`** —— 接收 adapter 從自己已驗證的 metadata 填入（adapter、來源種類與座標識別碼）。
 * - **`authored`** —— 投遞者逐字撰寫（標題、本文、發起者、座標標籤）。
 * - **來源專屬的原始內容** —— **不在本模組的任何型別裡**。
 *
 * 前兩組的區分不是文件上的分類，而是承重的：routing 拿哪一組當判準，決定的是「投遞者能不能
 * 自己選 session 開在哪個 repo」。以 `authored` 為判準的規則，等於讓他挑許可姿態最寬的那一個。
 *
 * ## 第三組為什麼連型別都沒有
 *
 * `parseIntake()` 的回傳值**沒有原始內容的欄位** —— 於是「依 Slack 的 channel 判斷」在型別上
 * 表達不出來，而不是靠一條「請不要讀它」的紀律。原始內容仍會被原封保存（供日後診斷與 Slack
 * adapter 使用），但那條路徑不經過這裡。
 *
 * **它也不會被交給 agent。** 上一版的設計由「保存的原始投遞」產生交給 agent 的檔案，而呈現給
 * 使用者的只有本文 —— 投遞者只要把乾淨的描述寫在本文、把指示藏在原始內容的任一欄位，
 * 使用者看到的與 agent 讀到的就是兩份不同的文字，**而型別守衛反而保證了沒有任何模組會呈現它**。
 *
 * ## 正規化在這裡發生，而且只發生一次
 *
 * 所有第三方可控的字串在攝入時被正規化，其結果即該字串**唯一的**表示；呈現與交付都是它的
 * 消費者。**位置是承重的**：若正規化發生在呈現層（那是最自然的位置，它讀起來就是一個渲染
 * 關切），交付的就是未正規化的原字串，兩者恰好差在一組看不見的字元上 ——「交給 agent 的內容
 * 逐字元等於呈現給使用者的內容」會在建構上不成立，而一個在主行程比對兩個純函式的單元測試
 * **永遠看不見它**（呈現那一端根本不在場）。
 *
 * 正規化是**白名單**（只保留可列印字元與換行），與識別碼的字元集同一條理由：
 * 「排除控制字元與雙向覆寫字元」是一個列舉不完的集合（C0、C1、bidi、零寬、行分隔、tag 字元…），
 * 漏掉任何一段都不會有東西變紅。既有的正確形式見 `preferences-store` 的 `sanitizeFamily`。
 */

import { parseAncestors } from '../shared/lineage/ancestry'
import type { HandoffSourceOrigin } from '../shared/lineage/types'

/**
 * **第三方逐字撰寫**的本文其長度上限。**訂在「一個人會實際讀完」的量級，不是技術極限。**
 *
 * 它是收件匣人類閘門有效性的唯一旋鈕：使用者要讀完本文才能按下接受，而把它調大只是讓他
 * 比較累 —— 不會有任何東西變紅。
 *
 * **它不適用於 `firstPartyBody` 的投遞**（見 `MAX_FIRST_PARTY_BODY_LENGTH`）。
 */
export const MAX_BODY_LENGTH = 4000

/**
 * **非第三方撰寫**（`firstPartyBody`）的本文其長度上限。
 *
 * 那條路徑不經接受閘，於是上面那個上限的**全部依據**在此不存在。換上的依據是
 * **接手的 agent 必須能一次讀完交付給它的整份內容** —— 讀不完時收尾界線不進脈絡，
 * 「界線之外的不算數」靜默失效，而它拿到的是半份工作。
 *
 * **這個依據的方向與上面那個相反**：調大不是讓人比較累，是讓交付靜默地只到一半。
 *
 * 值由實測得出（Claude Code 2.1.278，見 `docs/lessons/handoff.md` 第八節）：它是實測中
 * **完整讀取成功**的那一格，不是任何門檻的換算 —— 三道門檻裡有兩道（256 KB 的檔案大小、
 * 25,000 的單次讀取 token 上限）都不以字元計。**CLI 換版之後要重測。**
 *
 * 對照：一份真實的工作交接包約 5,700 字元。
 */
export const MAX_FIRST_PARTY_BODY_LENGTH = 20_000

/** 其餘 authored 欄位的長度上限。 */
export const MAX_FIELD_LENGTH = 200

/** 接收端可驗證的欄位 —— 由 adapter 填入，投遞者控制不到。 */
export interface IntakeVerified {
  /** 由**接收端**決定，不採信投遞內容自稱的來源。 */
  adapter: string
  /** 來源種類（`slack` / `github` / …）。**不是列舉** —— 不認得的值仍須放行。 */
  originKind: string
  /** 來源座標的識別碼（Slack 的 channel id、GitHub 的 repo…）。 */
  originId: string
  /**
   * 接收端**已經解析出**的目標 folder。可不存在（一般的投遞由 routing 規則決定目標）。
   *
   * **它 SHALL NOT 能由投遞內容表達**，而那不是紀律、是這個型別的形狀：`parseIntake()` 只從
   * `provenance` 參數取它，payload 裡同名的欄位走的是「未知欄位一律丟棄」那條路。
   *
   * 若它能被投遞內容表達，則**任何**放進共用投遞落點的檔案都能繞過 routing 自行選擇 folder ——
   * 而那個落點明文是給應用程式之外的 producer 用的。
   */
  targetFolderId?: string
  /**
   * 本文**不是**第三方逐字撰寫的。
   *
   * 今天唯一的來源是交接：本文由使用者自己 session 裡的 agent 撰寫、且由他當下的交辦觸發。
   * 它決定的是**交給 agent 的那一行 prompt**：第三方的本文要求 agent 逐字照抄其中的祈使句
   * 而**先不要動手**（那是人類閘門的另一半）；非第三方的本文**就是那件要做的事**。
   *
   * 與 `targetFolderId` 同一個姿態：**payload 表達不出來**。少了這個區分，一則使用者親口
   * 交辦的工作會變成一份「請把裡面的祈使句抄一遍」的清單 —— 使用者按下送出之後什麼也沒發生。
   */
  firstPartyBody?: boolean
  /**
   * 交接的**來源 session** 與它於攝入當下的呈現快照（`session-lineage`）。
   *
   * 與 `targetFolderId` 同一個姿態：**payload 表達不出來** —— 它由接收端從落點推導。
   * 建立子 session 時，主行程從這裡取來源寫進 session（見 `ipc/terminal.ts` 的 create），
   * 於是一則降級為待處理、數天後才被接受的交接，其快照仍是**交接當下**的樣子。
   */
  source?: HandoffSource
  /**
   * When a scheduled handoff opens (epoch ms), **only when it was later than the read time** (`scheduled-handoff`,
   * design D1). Decided once, at read time: no view compares it with the clock again.
   */
  scheduledAt?: number
  /** The target string the handoff's agent wrote, normalized: resolved again when the handoff opens. */
  targetText?: string
}

/** 歸屬的三態定義在 `src/shared/lineage/types.ts`（renderer 也要用）。 */
export type { HandoffSourceOrigin }

export interface HandoffSource {
  /** 來源 session 的 spekterm 識別碼（UUID）。 */
  sessionId: string
  origin: HandoffSourceOrigin
  /** 來源 session 當時的標籤。**agent 可控的文字**（pty 宣告，或使用者輸入）—— 見 `sourceTitle()`。 */
  title?: string
  /**
   * The source's own chain of ancestors at ingestion, nearest first (`agent-session-control` design D4). The
   * session created for this handoff records `[source, ...ancestors]` above itself. Taken now, not at creation:
   * the two can be days apart, and a parent closed in between would leave the chain broken.
   */
  ancestors?: string[]
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 來源標籤的正規化。
 *
 * 它放在「可驗證」這一組（不是 `actor`／`originLabel`）是因為那一組受 `MAX_FIELD_LENGTH` **拒絕**
 * 且會進入 `digestOf` —— 一個很長的標題會讓交接被判過長（agent 對此無能為力），而監看與掃描兩次
 * 讀取之間標題若恰好改變，就會產生一則假的「識別碼搶佔」。**但它仍是 agent 可控的文字**，所以
 * 照樣過 `normalizeAuthored`，只是以**截斷**處理長度（以 code point 為單位），換行收成空白。
 */
export function sourceTitle(raw: string): string {
  const flat = normalizeAuthored(raw).replace(/\n+/g, ' ').trim()
  return [...flat].slice(0, MAX_FIELD_LENGTH).join('')
}

/**
 * 讀回來源（**載入收件匣時**呼叫 —— 磁碟上的東西不受信任）。形狀不對一律回 `undefined`，
 * 呼叫端丟掉這一組欄位即可，record 本身保留。
 */
export function parseHandoffSource(raw: unknown): HandoffSource | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.sessionId !== 'string' || !UUID_SHAPE.test(r.sessionId)) return undefined
  const o = r.origin as Record<string, unknown> | undefined
  if (typeof o !== 'object' || o === null) return undefined
  let origin: HandoffSourceOrigin
  switch (o.kind) {
    case 'folder':
      if (typeof o.folderId !== 'string' || o.folderId === '' || typeof o.folderName !== 'string') return undefined
      origin = { kind: 'folder', folderId: o.folderId, folderName: o.folderName }
      break
    case 'global':
      origin = { kind: 'global' }
      break
    case 'unknown':
      origin = { kind: 'unknown' }
      break
    default:
      return undefined
  }
  const ancestors = parseAncestors(r.ancestors)
  return {
    sessionId: r.sessionId,
    origin,
    ...(typeof r.title === 'string' && r.title !== '' ? { title: sourceTitle(r.title) } : {}),
    ...(ancestors ? { ancestors } : {}),
  }
}

/**
 * 接收端供應的來源與目標 —— 與 `adapter` 同一個姿態：**payload 自稱的一律不採信**。
 *
 * 只有算得出這些值的 adapter 會傳它（交接由投遞落在哪個 session 的目錄推出來源、由查表解析
 * 目標）。不傳時，來源座標沿用投遞內容中的值 —— 那是外部 producer 的既有契約。
 */
export interface DeliveryProvenance {
  origin: { kind: string; id: string; label: string }
  targetFolderId: string
  /** 見 `IntakeVerified.firstPartyBody`。 */
  firstPartyBody?: boolean
  /** 見 `IntakeVerified.source`。 */
  source?: HandoffSource
  /** See `IntakeVerified.scheduledAt`. */
  scheduledAt?: number
  /** See `IntakeVerified.targetText`. */
  targetText?: string
  /**
   * The record is opened by `HandoffOpener` (`scheduled-handoff`): it gets `opensAt`, the scheduled time or the
   * read time. Not a verified field — it is the record's state, kept with the dedupe key.
   */
  autoOpen?: boolean
}

/** 第三方逐字撰寫的欄位 —— 投遞者完全控制其內容。 */
export interface IntakeAuthored {
  title: string
  body: string
  actor: string
  /** 來源座標的**標籤**（channel 名稱之類）—— 與 `originId` 不同，這是可變的字串。 */
  originLabel: string
  /**
   * 這件事**於來源發生**的時刻（毫秒）。選填 —— 沒有時收件匣以到達的時間代之。
   *
   * **它在第三方撰寫的這一組**：Slack adapter 也是經共用落點投遞的 producer，它寫的東西與外部
   * producer 同樣不受信任。因此它只用於呈現與排序，**不作任何判斷依據**（routing 不比對它、
   * 去重的摘要不納入它），而它的效力有上限 —— 不得晚於到達時間（見 `intake-projection.ts`）。
   *
   * 存在的理由是回補（intake-inbox-usability）：應用程式關閉期間發生的事於啟動時一次進來，
   * 只看到達時間的話，昨天的事會顯示成「剛剛」。
   */
  occurredAt?: number
}

export interface Intake {
  id: string
  verified: IntakeVerified
  authored: IntakeAuthored
  receivedAt: number
}

export type IntakeRejection =
  /**
   * 交接專屬的三種拒絕。**它們與其餘的差別是：這條路徑上沒有人在等著按接受**，於是
   * 「什麼都沒發生」與成功在畫面上完全相同 —— 因此它們**會發通知**（`agent-intake` 的
   * 「被拒絕的投遞不發通知」在此有一條明寫的例外）。
   *
   * `MALFORMED` **不在其中**：那種項目刻意不被消費，每次補寫都會再被讀到，逐次通知沒有上界。
   */
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'PREFILL_UNAVAILABLE'
  /** 完成報告來自一個**不是**由交接建立的 session（`handoff-completion`）。 */
  | 'REPORT_NOT_HANDOFF'
  /** A session command named no existing session (`agent-session-control`). */
  | 'CONTROL_TARGET_NOT_FOUND'
  /** A session command named a session that is neither its source nor a descendant of it. */
  | 'CONTROL_NOT_ALLOWED'
  /** The interface could not carry a session command out: the session vanished in between, or an error. */
  | 'CONTROL_FAILED'
  /** No window carried a session command out in time. */
  | 'CONTROL_NO_WINDOW'
  /** A close or hibernate of a running session while agent events are off: its turn cannot be observed. */
  | 'CONTROL_UNAVAILABLE'
  /** A handoff's `at` breaks the scheduling rules: its form, a missing offset, a date that does not exist, the bound. */
  | 'SCHEDULE_INVALID'
  | 'MALFORMED'
  | 'MISSING_ID'
  | 'INVALID_ID'
  | 'FIELD_TYPE'
  | 'TOO_LONG'
  | 'TOO_LARGE'
  | 'DUPLICATE'
  | 'CAPACITY'

export interface ParseFailure {
  ok: false
  code: IntakeRejection
  /** 給人看的細節。**不含投遞的原文** —— 它尚未經過正規化。 */
  detail?: string
}

export type ParseResult = { ok: true; value: Intake } | ParseFailure

/**
 * 正規化一個第三方可控的字串：**白名單**，只保留可列印字元與換行。
 *
 * 判準以 code point 為單位（`for…of` 走的是 code point，不是 UTF-16 code unit），於是
 * 補充平面的字元不會被拆成兩個 surrogate 而其中一個被誤判。
 */
export function normalizeAuthored(value: string): string {
  let out = ''
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    if (ch === '\n') {
      out += ch
      continue
    }
    // C0（含 DEL）與 C1 一律移除。
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue
    // 雙向控制、零寬、行/段分隔、BOM、以及 tag 字元（隱形文字注入最常用的一段）。
    if (cp >= 0x200b && cp <= 0x200f) continue
    if (cp >= 0x2028 && cp <= 0x202e) continue
    if (cp >= 0x2060 && cp <= 0x2064) continue
    if (cp >= 0x2066 && cp <= 0x2069) continue
    if (cp === 0xfeff) continue
    if (cp >= 0xe0000 && cp <= 0xe007f) continue
    out += ch
  }
  return out
}

/**
 * 取得本文 —— **唯一的 accessor**。
 *
 * 「呈現的那份就是交付的那份」是這條管線人類閘門的另一半，而它最自然的失效方式是
 * **兩端各自取值**。把取用收斂成一個入口，配上 `scripts/intake-context-source.test.mjs`
 * 的守衛（`.authored.body` 只能出現在本模組），就把那條紀律換成了結構。
 *
 * 兩個承重的呼叫點是**送往 renderer 的投影**與**寫出 context 檔** —— 它們必須是同一個字串。
 * routing 的比對也走這裡（它讀的是同一份內容，沒有理由另開一條路）。
 */
export function bodyOf(intake: Intake): string {
  return intake.authored.body
}

/**
 * ISO 8601 的日期時刻，**必須帶時區**（`Z` 或 `±hh:mm`）。
 *
 * 不交給 `Date.parse` 自由發揮：它接受的格式由實作定義（`'Sep 22 2026'` 也吃），而不帶時區的
 * 時刻會被當成**本機時間** —— 同一份投遞在不同時區的機器上呈現成不同的時刻，卻不會有任何錯誤。
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** `undefined` ＝ 沒有宣告；`null` ＝ 宣告了但不是可解析的時刻。 */
function readInstant(source: Record<string, unknown>, key: string): number | null | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

/**
 * 把一份投遞的 JSON 解析成一則 intake。
 *
 * `adapter` 由**呼叫端**供應（接收端決定），payload 裡自稱的來源一律不採信。
 * 回傳值不含原始內容 —— 那由呼叫端另行保存。
 */
export function parseIntake(
  raw: unknown,
  adapter: string,
  provenance?: DeliveryProvenance,
): ParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'MALFORMED', detail: 'payload is not an object' }
  }
  const source = raw as Record<string, unknown>

  const id = readString(source, 'id')
  if (id === null || id === '') return { ok: false, code: 'MISSING_ID' }

  // **接收端供應來源時，投遞內容裡的 `origin` 完全不被讀取** —— 連格式都不檢查，因為它不會
  // 被使用。這比「讀進來再覆蓋」強：後者讓「忘記覆蓋」變成一個可能的實作。
  const originFields: Record<string, unknown> = provenance
    ? {}
    : ((): Record<string, unknown> => {
        const origin = source.origin
        return typeof origin === 'object' && origin !== null && !Array.isArray(origin)
          ? (origin as Record<string, unknown>)
          : {}
      })()
  if (!provenance) {
    const origin = source.origin
    if (typeof origin !== 'object' || origin === null || Array.isArray(origin)) {
      return { ok: false, code: 'FIELD_TYPE', detail: 'origin' }
    }
  }

  // **`originKind` 不以列舉白名單判定。** 一個不認得的來源種類仍須放行 —— 否則新增一種來源
  // 就要改這裡，而 D3 的「新增來源不改收件匣以內任何判斷」即失效。
  const originKind = provenance ? provenance.origin.kind : readString(originFields, 'kind')
  const originId = provenance ? provenance.origin.id : readString(originFields, 'id')
  if (originKind === null || originId === null) {
    return { ok: false, code: 'FIELD_TYPE', detail: 'origin.kind / origin.id' }
  }

  const body = readString(source, 'body')
  if (body === null) return { ok: false, code: 'FIELD_TYPE', detail: 'body' }

  const title = readString(source, 'title') ?? ''
  const actor = readString(source, 'actor') ?? ''
  const originLabel = provenance ? provenance.origin.label : (readString(originFields, 'label') ?? '')

  // **宣告了卻不可解析 ⇒ 整則拒絕**，與其他欄位型別不符同一個處置（永久性）。靜默丟掉它的話，
  // producer 的格式錯誤永遠不會被看見 —— 它的每一則都會以到達時間呈現，而沒有人知道為什麼。
  const occurredAt = readInstant(source, 'occurredAt')
  if (occurredAt === null) return { ok: false, code: 'FIELD_TYPE', detail: 'occurredAt' }

  const authored: IntakeAuthored = {
    title: normalizeAuthored(title),
    body: normalizeAuthored(body),
    actor: normalizeAuthored(actor),
    originLabel: normalizeAuthored(originLabel),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  }

  // **長度以正規化之後判定。** 以原文判定的話，一串被剝掉的不可見字元可以把一則合法的投遞
  // 推過上限，而使用者看到的內容其實很短。
  //
  // **本文的上限依「是否為第三方逐字撰寫」分流，其餘欄位不分流。** `title` 是清單裡的一行，
  // 那**是**一個呈現預算，對兩條路徑同樣成立；而本文的那個上限保護的是接受閘，
  // 非第三方的投遞不經那道閘（見兩個常數各自的註解）。
  //
  // **分流的是「套哪一個」，不是「怎麼量」** —— 尺度仍是正規化之後的 UTF-16 code unit。
  const bodyLimit = provenance?.firstPartyBody ? MAX_FIRST_PARTY_BODY_LENGTH : MAX_BODY_LENGTH
  if (authored.body.length > bodyLimit) {
    return { ok: false, code: 'TOO_LONG', detail: 'body' }
  }
  for (const [key, value] of Object.entries(authored)) {
    // 只有字串欄位有長度（發生時間是一個數字）。
    if (typeof value === 'string' && key !== 'body' && value.length > MAX_FIELD_LENGTH) {
      return { ok: false, code: 'TOO_LONG', detail: key }
    }
  }

  return {
    ok: true,
    value: {
      id,
      verified: {
        adapter,
        originKind: normalizeAuthored(originKind),
        originId,
        // **只從 `provenance` 取** —— payload 裡的同名欄位從未被讀到。
        ...(provenance ? { targetFolderId: provenance.targetFolderId } : {}),
        ...(provenance?.firstPartyBody ? { firstPartyBody: true } : {}),
        ...(provenance?.source ? { source: provenance.source } : {}),
        ...(provenance?.scheduledAt !== undefined ? { scheduledAt: provenance.scheduledAt } : {}),
        ...(provenance?.targetText !== undefined ? { targetText: provenance.targetText } : {}),
      },
      authored,
      receivedAt: Date.now(),
    },
  }
}
