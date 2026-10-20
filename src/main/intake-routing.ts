import fs from 'node:fs'
import path from 'node:path'

import { bodyOf, type Intake } from './intake-schema'

/**
 * 把一則 intake 解析成一個 `folderId`。
 *
 * ## 判準分兩類，而那個分類是承重的
 *
 * - **接收端可驗證的**（`originKind` / `originId`）—— adapter 從自己已驗證的 metadata 填入。
 * - **第三方逐字撰寫的**（`title` / `body` / `actor` / `originLabel`）—— 投遞者完全控制。
 *
 * 以後者為判準，等於**讓投遞者選擇他的 intake 會落在哪個工作目錄** —— 而他會選許可姿態最寬鬆
 * 的那一個。**這件事無法以驗證化解**（那些欄位本來就該是自由文字），只能讓使用者在建立規則的
 * 當下知道他在交出什麼，因此 `isAuthoredCriterion()` 存在、而編輯介面必須據它標示。
 *
 * ## 查無對應一律拒絕，不靜默改道
 *
 * 沒有規則命中且未設 fallback ⇒ 拒絕。**命中的 folder 已不在 workspace 中時也拒絕**，
 * SHALL NOT 往下繼續比對或落到 fallback —— 使用者明確指定的目標不可用時，正確的處置是告訴他。
 * 理由與工作目錄識別碼查無對應時同源：靜默退回會讓一個 session 開在他以為的地方以外。
 */

export type RuleCriterion = 'originKind' | 'originId' | 'title' | 'body' | 'actor' | 'originLabel'

const CRITERIA: readonly RuleCriterion[] = [
  'originKind',
  'originId',
  'title',
  'body',
  'actor',
  'originLabel',
]

/** 第三方逐字撰寫的判準 —— 編輯介面必須標示它可被投遞者操縱。 */
const AUTHORED: ReadonlySet<RuleCriterion> = new Set<RuleCriterion>([
  'title',
  'body',
  'actor',
  'originLabel',
])

export function isAuthoredCriterion(criterion: RuleCriterion): boolean {
  return AUTHORED.has(criterion)
}

export interface RoutingRule {
  id: string
  criterion: RuleCriterion
  /** 子字串比對，不分大小寫。 */
  contains: string
  folderId: string
}

export interface RoutingConfig {
  rules: RoutingRule[]
  fallbackFolderId: string | null
}

export type RoutingRejection = 'NO_MATCH' | 'FOLDER_GONE'

export type RoutingResult =
  | { ok: true; folderId: string }
  | { ok: false; reason: RoutingRejection; folderId?: string }

function valueOf(intake: Intake, criterion: RuleCriterion): string {
  switch (criterion) {
    case 'originKind':
      return intake.verified.originKind
    case 'originId':
      return intake.verified.originId
    case 'title':
      return intake.authored.title
    case 'body':
      return bodyOf(intake)
    case 'actor':
      return intake.authored.actor
    case 'originLabel':
      return intake.authored.originLabel
  }
}

/**
 * 依序比對，**第一個命中的規則勝出**，其後的規則不再參與。
 *
 * `knownFolderIds` 是當下 workspace 的 folder 集合 —— 命中一條指向已移除 folder 的規則時
 * **拒絕**，而不是當作沒命中。
 */
export function resolveRouting(
  config: RoutingConfig,
  intake: Intake,
  knownFolderIds: ReadonlySet<string>,
): RoutingResult {
  // **已由接收端解析出目標者不比對規則、也不落 fallback。**
  //
  // 規則是**使用者**用來決定「一件外部的事該在哪裡處理」的工具；而這種 intake 的目標是使用者
  // 自己指名的（交接時他說了「交給 b repo」）。讓規則有機會改寫它，等於讓一條為別的用途寫的
  // 規則把他的指名蓋掉。
  //
  // **該 folder 已不在 workspace 時仍然拒絕**，理由與「命中規則所指向的 folder 已移除」完全
  // 相同：明確指定的目標不可用時，正確的處置是告訴他，不是悄悄換一個地方。
  const addressed = intake.verified.targetFolderId
  if (addressed !== undefined) {
    return knownFolderIds.has(addressed)
      ? { ok: true, folderId: addressed }
      : { ok: false, reason: 'FOLDER_GONE', folderId: addressed }
  }
  // An agent named the target, but it resolved to no folder: a repeating handoff's occurrence created after its
  // folder left the workspace. Its target is still named; the rules and the fallback must not pick another.
  if (intake.verified.targetText !== undefined) return { ok: false, reason: 'FOLDER_GONE' }

  for (const rule of config.rules) {
    const haystack = valueOf(intake, rule.criterion).toLowerCase()
    if (!haystack.includes(rule.contains.toLowerCase())) continue
    if (!knownFolderIds.has(rule.folderId)) {
      return { ok: false, reason: 'FOLDER_GONE', folderId: rule.folderId }
    }
    return { ok: true, folderId: rule.folderId }
  }

  const fallback = config.fallbackFolderId
  if (fallback === null) return { ok: false, reason: 'NO_MATCH' }
  if (!knownFolderIds.has(fallback)) return { ok: false, reason: 'FOLDER_GONE', folderId: fallback }
  return { ok: true, folderId: fallback }
}

/**
 * 規則的持久化 —— **本能力自己的檔案，不進 `preferences.json`**。
 *
 * 使用者偏好那份檔案的寫入路徑會**從空物件重建**其內容、且整份檔案於每次儲存時被重新產生，
 * 任何寄居其中的欄位都倚賴每一個寫入者記得保留它。規則被那條路徑丟棄時，**fallback 可能仍在**
 * （或反之），於是其後每一則 intake 都靜默地改道 —— **而介面上呈現的解析結果是誠實的**，
 * 它報的就是那個錯誤的結果。使用者調整一次字型，收件匣就改了道。
 */
export const ROUTING_VERSION = 1

interface PersistedRouting {
  version: number
  rules: RoutingRule[]
  fallbackFolderId: string | null
}

export function parseRoutingFile(raw: string): RoutingConfig | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const { version, rules, fallbackFolderId } = data as Record<string, unknown>
  if (version !== ROUTING_VERSION) return null

  // **逐條白名單**：形狀不合的單條被忽略，其餘照常生效 ——
  // 一個欄位的損毀不該讓使用者失去全部規則。
  const kept: RoutingRule[] = []
  if (Array.isArray(rules)) {
    for (const entry of rules) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      if (typeof e.id !== 'string' || typeof e.contains !== 'string') continue
      if (typeof e.folderId !== 'string') continue
      if (!CRITERIA.includes(e.criterion as RuleCriterion)) continue
      kept.push({
        id: e.id,
        criterion: e.criterion as RuleCriterion,
        contains: e.contains,
        folderId: e.folderId,
      })
    }
  }

  return {
    rules: kept,
    fallbackFolderId: typeof fallbackFolderId === 'string' ? fallbackFolderId : null,
  }
}

export class RoutingStore {
  #config: RoutingConfig = { rules: [], fallbackFolderId: null }

  constructor(private readonly filePath: string) {}

  load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch {
      return
    }
    const parsed = parseRoutingFile(raw)
    if (parsed) this.#config = parsed
  }

  get(): RoutingConfig {
    return { rules: this.#config.rules.map((r) => ({ ...r })), fallbackFolderId: this.#config.fallbackFolderId }
  }

  replace(config: RoutingConfig): void {
    this.#config = {
      rules: config.rules.map((r) => ({ ...r })),
      fallbackFolderId: config.fallbackFolderId,
    }
    this.#save()
  }

  #save(): void {
    const payload: PersistedRouting = {
      version: ROUTING_VERSION,
      rules: this.#config.rules,
      fallbackFolderId: this.#config.fallbackFolderId,
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }
}

export function routingFile(userDataPath: string): string {
  return path.join(userDataPath, 'intake-routing.json')
}
