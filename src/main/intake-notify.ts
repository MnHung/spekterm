import { t } from '@shared/i18n'

import type { IntakeRecord } from './intake-store'
import type { IntakeFailure } from './intake-service'

/**
 * 通知的**決策層** —— 何時發、發幾則、發什麼。**這一層不碰作業系統。**
 *
 * ## 為什麼決策與呈現要分開
 *
 * 「通知真的出現在桌面上」在虛擬螢幕的驗收環境裡看不到，而「該不該發、發了幾則、裡面是什麼」
 * 是這個能力全部的行為。把兩者揉在一起，等於把可驗的那一半也推進不可驗的那一半。
 *
 * ## 合併是固定窗口，不是 debounce
 *
 * debounce（每次到達都把計時器往後推）在**穩定滴入**時永遠不會到期 —— 越是有事情發生，
 * 越沒有通知。而它與固定窗口在「單則到達」與「一次批次」兩種情況下的結果**完全相同**，
 * 所以只驗那兩種等於沒驗。判準要落在 **0 與非 0 之間**。
 *
 * ## 兩層界
 *
 * 合併只防批次、**不防節奏**：每數分鐘到達一則時，每個窗結算的都是單則形式，於是這條通道
 * 可以無限期地每小時響十幾次。待處理總量上限也不是界 —— 使用者每清掉一則就釋放一格，
 * **越認真清收件匣，這條通道越吵**。因此另有一層「窗與窗之間」的上界，以使用者打開收件匣
 * 為重置點。
 */

/** 交給後端的一則通知。**這就是後端看得到的全部** —— 它不做任何判斷。 */
export interface NotifyPayload {
  title: string
  body: string
}

/**
 * 一則通知涵蓋了哪些項目。
 *
 * **通知的效果因項目而異**（待處理者打開收件匣、已建立 session 者聚焦那個 session），
 * 而觸發發生在呈現之後 —— 中間隔著使用者的時間，項目的狀態在那段時間內會改變。
 * 因此這裡帶的是**主鍵**而不是當下的狀態：目的地在**觸發的當下**才決定。
 *
 * 舊的簽章 `onActivate(handler: () => void)` **不帶任何識別**，於是「聚焦這則交接建立的
 * session」在介面上表達不出來 —— 那是一次介面變更，不是一個參數。
 */
export interface IntakeKeyRef {
  adapter: string
  id: string
}

export interface NotifyBackend {
  /** 呈現一則。`keys` 是這一則涵蓋的項目，供觸發時決定目的地。 */
  present(payload: NotifyPayload, keys: readonly IntakeKeyRef[]): void
  /** 這個執行環境送得出通知嗎。**注意它守不到真正的失效**，見 `docs/lessons/intake.md` 第七節。 */
  usable(): boolean
  /**
   * 註冊「使用者觸發了通知」的回呼。
   *
   * **不得改名為那個 HTTP 伺服器慣用的動詞** —— `probe-core.mjs` 的「主行程未建立 server」
   * 守衛是純文字比對，而且連註解一起吃（`agent-wait.ts` 的檔頭記過同一個坑）。
   */
  onActivate(handler: (keys: readonly IntakeKeyRef[]) => void): void
}

/** 時鐘與計時器 —— 注入它，驗收才不必真的等。 */
export interface NotifyClock {
  now(): number
  /** 回傳取消函式。 */
  after(ms: number, fn: () => void): () => void
}

export const realClock: NotifyClock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms)
    // 通知不該讓行程活著。
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

/** 合併窗。秒級 —— 一次回補的十幾則要落在同一個窗裡，而單則到達的延遲要察覺不到。 */
export const WINDOW_MS = 4000

/** 窗與窗之間的上界：這段時間內最多這麼多則。 */
export const BURST_WINDOW_MS = 30 * 60_000
export const BURST_MAX = 6

/**
 * 第三方欄位進入通知之前的**縮減**上限（code point）。
 *
 * 實測：執行環境不截短、不報錯、不回報失敗 —— **上限只能由我們自己定**。取小的理由是通知
 * 要回答的問題是「要不要現在切過去」，不是閱讀；而取小同時縮小 URL 與標記的曝露面。
 */
export const FIELD_MAX = 80

/**
 * URL 的形狀。**刻意寬**（連 `www.` 與裸網域都吃）—— 桌面通知服務的 linkify 就是這麼寬的，
 * 而這裡漏掉的每一個形狀都會變成桌面上一個可點的連結。
 */
const URL_SHAPE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi

/**
 * 把一個**已正規化**的第三方欄位縮減成可以放進通知的形狀。
 *
 * **這裡刻意不做轉義。** 轉義只對**宣告**標記能力的通知服務正確；對不宣告的服務，轉義後的
 * 字面會直接顯示給使用者看 —— 而執行環境沒有把服務的能力宣告暴露出來，我們無從分支。
 * 一個只對某一類桌面正確的處置，不比沒有處置好多少。（下一個人很可能會想「修正」成轉義。）
 *
 * **而這不是「正規化做第二次」**：正規化的產出是那個**值**，只有一份，仍然只在攝入發生一次；
 * 這裡的產出是**為了某個目的地而失真的呈現**，與呈現層把同一個值交給會自動轉義的渲染器
 * 是同一類動作。
 */
export function reduceForNotification(value: string): string {
  const withoutUrls = value.replace(URL_SHAPE, t('intake.notify.link'))
  const withoutMarkup = withoutUrls.replace(/[<>&]/g, '')
  const points = [...withoutMarkup]
  const clipped = points.length > FIELD_MAX ? `${points.slice(0, FIELD_MAX).join('')}…` : withoutMarkup
  return clipped.trim()
}

/**
 * 窗內累積的一個項目 —— **到達與失敗共用同一個批次、同一個窗、同一組上界**。
 *
 * 分成兩條通道的代價是實際的：投遞者控制數量，而「面向使用者的拒絕與警示 SHALL 有界」
 * 的那份合併與上限只能有一份。兩條通道各自有界 ⇒ 合起來是兩倍。
 */
export type NotifyItem =
  | { kind: 'arrival'; record: IntakeRecord }
  | { kind: 'failure'; failure: IntakeFailure }
  /**
   * 一份完成報告被採納了（`handoff-completion`）。它不是一則 intake —— 主鍵以
   * `COMPLETION_ADAPTER` ＋ session 識別碼表示，觸發時據此把使用者帶去那個 session 的交接單。
   */
  | { kind: 'completion'; sessionId: string; title: string; summary: string }

/** 完成通知在主鍵上用的 adapter 名 —— **不是任何 intake 的 adapter**，觸發時據此分流。 */
export const COMPLETION_ADAPTER = 'handoff-completion'

export function buildPayload(items: readonly NotifyItem[]): NotifyPayload {
  const failures = items.filter((item) => item.kind === 'failure')
  const batch = items.filter((item) => item.kind === 'arrival').map((item) => item.record)
  const completions = items.flatMap((item) => (item.kind === 'completion' ? [item] : []))

  /**
   * **完成通知**（`handoff-completion`）。只有它一則時才說出是哪件事與結果；與其他項目落在同一個窗裡
   * 就走合併的那一則（打開收件匣）—— 一則講不清楚好幾件事。
   *
   * 交接標題與摘要都經縮減：摘要是 agent 寫的，而 agent 可能被它讀過的東西塑形。
   */
  if (completions.length === 1 && items.length === 1) {
    const title = reduceForNotification(completions[0].title)
    const summary = reduceForNotification(completions[0].summary)
    return {
      title: t('handoffLifecycle.notify.title'),
      body: title
        ? t('handoffLifecycle.notify.single', { title, summary })
        : t('handoffLifecycle.notify.singleUntitled', { summary }),
    }
  }
  if (completions.length > 0) {
    return { title: t('intake.notify.titleMerged', { total: items.length }), body: t('intake.notify.merged') }
  }

  /**
   * **失敗的內文只由系統文案與拒絕的類別構成。**
   *
   * 一則失敗**沒有可供取用的已驗證欄位** —— 它正是在攝入失敗的，`title` / `actor` /
   * `originLabel` 三者要嘛不存在、要嘛從未經過正規化。而既有的「內文 SHALL NOT 含任何路徑、
   * folder 名稱或識別碼」在此不放寬：投遞者寫下的目標**就是**一個 folder 名稱。
   *
   * 使用者要知道是哪一件事，去收件匣看痕跡 —— 而這則通知的效果正是打開收件匣。
   */
  if (failures.length === 1 && batch.length === 0) {
    const { failure } = failures[0]
    const reason = t(`intake.rejectReason.${failure.code}`)
    // A session command is not a handoff, and saying "a handoff could not be delivered" sends the user looking
    // for one (`agent-session-control`). A merged notification below counts items without naming them.
    if (failure.subject === 'command') {
      return { title: t('intake.notify.commandTitle'), body: t('intake.notify.commandFailure', { reason }) }
    }
    return { title: t('intake.notify.title'), body: t('intake.notify.failure', { reason }) }
  }
  if (failures.length > 0) {
    return {
      title: t('intake.notify.titleMerged', { total: items.length }),
      body: t('intake.notify.merged'),
    }
  }

  if (batch.length > 1) {
    return {
      title: t('intake.notify.titleMerged', { total: batch.length }),
      // **合併的那一則不含任何第三方文字** —— 一則講不清楚十件事，而硬要塞等於讓投遞者
      // 挑選哪一句會出現在桌面上。
      body: t('intake.notify.merged'),
    }
  }

  const record = batch[0]
  const authored = record.content?.authored
  const origin = reduceForNotification(authored?.originLabel ?? '')
  const actor = reduceForNotification(authored?.actor ?? '')
  const title = reduceForNotification(authored?.title ?? '')

  return {
    // **標題恆為系統文案。** 容許投遞者影響它，桌面上就會出現一則與本應用程式自己發出的
    // 別無二致的訊息，而使用者沒有任何線索分辨。
    title: t('intake.notify.title'),
    body: actor
      ? t('intake.notify.single', { origin, actor, title })
      : t('intake.notify.singleNoActor', { origin, title }),
  }
}

export interface NotifierOptions {
  backend: NotifyBackend
  clock?: NotifyClock
  windowMs?: number
  burstWindowMs?: number
  burstMax?: number
}

export class IntakeNotifier {
  readonly #backend: NotifyBackend
  readonly #clock: NotifyClock
  readonly #windowMs: number
  readonly #burstWindowMs: number
  readonly #burstMax: number

  #batch: NotifyItem[] = []
  #cancel: (() => void) | null = null
  /** 已呈現的時刻 —— 用來判定窗與窗之間的上界。 */
  #presented: number[] = []

  constructor({
    backend,
    clock = realClock,
    windowMs = WINDOW_MS,
    burstWindowMs = BURST_WINDOW_MS,
    burstMax = BURST_MAX,
  }: NotifierOptions) {
    this.#backend = backend
    this.#clock = clock
    this.#windowMs = windowMs
    this.#burstWindowMs = burstWindowMs
    this.#burstMax = burstMax
  }

  /**
   * 一則 intake 到達了。
   *
   * **窗自第一則到達起算，且後續的到達不得把它往後推** —— 那個「往後推」正是 debounce，
   * 而它在持續到達時永遠不會到期。
   */
  arrived(record: IntakeRecord): void {
    this.#push({ kind: 'arrival', record })
  }

  /**
   * 一次**永久性**失敗 —— 「使用者剛剛交辦的一件事確定做不成了」。
   *
   * 它與到達共用窗與上界（見 `NotifyItem`）。暫時性的失敗不走這裡：那類項目會在每次補寫或
   * 重試時再被讀到，逐次通知沒有上界，而合併只防批次、不防節奏。
   */
  failed(failure: IntakeFailure): void {
    this.#push({ kind: 'failure', failure })
  }

  /**
   * 一份完成報告被採納了（`handoff-completion`）。**與到達、失敗共用同一個窗與同一組上界** ——
   * 兩條通道各自有界等於兩倍。呼叫端保證同一份報告只呼叫一次（綁定於採納，不綁定於狀態）。
   */
  completed(sessionId: string, title: string, summary: string): void {
    this.#push({ kind: 'completion', sessionId, title, summary })
  }

  #push(item: NotifyItem): void {
    this.#batch.push(item)
    if (this.#cancel !== null) return
    this.#cancel = this.#clock.after(this.#windowMs, () => this.#flush())
  }

  /** 使用者打開了收件匣 —— 上界的重置點。 */
  inboxOpened(): void {
    this.#presented = []
  }

  #flush(): void {
    this.#cancel = null
    const batch = this.#batch
    this.#batch = []
    if (batch.length === 0) return
    if (!this.#backend.usable()) return

    const now = this.#clock.now()
    this.#presented = this.#presented.filter((at) => now - at < this.#burstWindowMs)
    // **逾越上界即不再各自發出。** 使用者打開收件匣就重置 —— 那是「他已經知道了」唯一
    // 可觀察的訊號。
    if (this.#presented.length >= this.#burstMax) return

    this.#presented.push(now)
    /**
     * **批次中含任何失敗時不提供主鍵 ⇒ 效果是打開收件匣。**
     *
     * 目的地由主鍵決定（`index.ts`：恰一則、已接受、session 還在 ⇒ 聚焦那個 session）。
     * 一則失敗**沒有**主鍵（它不是一則 record），於是「一則成功交接 ＋ 一則失敗」落在同一個
     * 窗裡時，主鍵數會恰好是 1 —— 使用者被送去那個 session，而那則失敗**從這條通道上消失**。
     *
     * 理由與「批次中含待處理項時打開收件匣」完全相同。
     */
    const hasFailure = batch.some((item) => item.kind === 'failure')
    const keys = hasFailure
      ? []
      : batch.flatMap((item) =>
          item.kind === 'arrival'
            ? [{ adapter: item.record.adapter, id: item.record.id }]
            : item.kind === 'completion'
              ? [{ adapter: COMPLETION_ADAPTER, id: item.sessionId }]
              : [],
        )
    this.#backend.present(buildPayload(batch), keys)
  }

  /** 測試用：目前窗內累積了幾則。 */
  pendingInWindow(): number {
    return this.#batch.length
  }
}
