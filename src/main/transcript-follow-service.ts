import fs from 'node:fs'
import path from 'node:path'

import type { FSWatcher } from 'chokidar'

import { createWatcher } from './watcher'
import {
  attachmentOf,
  consume,
  initialFollowState,
  parseLine,
  planRead,
  project,
  type Attachment,
  type FollowState,
  type ViewEvent,
} from './transcript-follow'
import { foldSkills, sameSkills, type SkillList } from './transcript-skills'

/**
 * 紀錄跟進的服務層 —— 定位、監看、生命週期。純邏輯在 `transcript-follow.ts`。
 *
 * ## 兩層監看，理由與 `branch-service` 監看 `.git/HEAD` 相同
 *
 * 監看一個**尚不存在**的檔案是行不通的（chokidar 無從 attach）。而紀錄在 agent 寫出第一則之前
 * 就是不存在的，那是**主線情境**不是例外。因此第一層監看它所在的目錄（等它出現），
 * 第二層才監看檔案本身。
 *
 * ## 拆除只由 session 自身的結束觸發
 *
 * **`SessionEnd` 這個 hook 不是那個訊號。** 實測（2026-09-06、CLI 2.1.263）：使用者在 agent 之內
 * 清空對話時它就會發，**而 pty 還活著**。把它接上拆除，使用者按一次清空，跟進就此停住 ——
 * 而 session 正常、終端正常、沒有任何錯誤。它的正確語意是「接下來可能換一份紀錄」，
 * 因此接到 `relocate()`。
 */

export interface FollowerDeps {
  /** 注入以便測試。產品路徑一律走 `./watcher`（那是 chokidar 的唯一入口）。 */
  makeWatcher?: typeof createWatcher
  statSize?: (target: string) => number | null
  readRange?: (target: string, from: number, to: number) => Buffer | null
  exists?: (target: string) => boolean
  /**
   * The skills the agent was told it can invoke, as far as the transcript read so far says (`transcript-skills.ts`):
   * after the first read and on every change, `null` when it holds no listing. Only a device's watch asks for it.
   */
  onSkills?: (skills: SkillList) => void
}

function defaultStatSize(target: string): number | null {
  try {
    return fs.statSync(target).size
  } catch {
    return null
  }
}

function defaultReadRange(target: string, from: number, to: number): Buffer | null {
  if (to <= from) return Buffer.alloc(0)
  let fd: number | null = null
  try {
    fd = fs.openSync(target, 'r')
    const buf = Buffer.alloc(to - from)
    const read = fs.readSync(fd, buf, 0, buf.length, from)
    return buf.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // 已關閉的 fd 關不動 —— 那正是我們要的狀態。
      }
    }
  }
}

/**
 * 跟進的呈現狀態。**「讀不到」與「還沒講話」必須可區分**：
 *
 * - `ok` ＋ 空陣列 ＝ **還沒講話**（含紀錄檔尚不存在 —— 那是每個新 session 的必經狀態）
 * - `unavailable` ＝ **讀不到**（存在但讀不出來）
 * - `attaching` ＝ 呈現層自己的初始值，在收到第一則更新之前。**主行程不送這個狀態。**
 */
export type FollowStatus = 'attaching' | 'ok' | 'unavailable'

export interface FollowUpdate {
  sessionId: string
  status: FollowStatus
  events: ViewEvent[]
  /** 較早的內容因量體上限而未載入。 */
  truncated: boolean
  /** `true` 代表呈現層應清空既有內容再套用（來源被改寫或換過）。 */
  reset: boolean
}

export class TranscriptFollower {
  readonly #sessionId: string
  readonly #deps: Required<Omit<FollowerDeps, 'onSkills'>>
  readonly #onSkills: ((skills: SkillList) => void) | undefined
  readonly #emit: (update: FollowUpdate) => void

  #target: string | null = null
  #dirWatcher: FSWatcher | null = null
  #fileWatcher: FSWatcher | null = null
  #state: FollowState = initialFollowState()
  #attached = false
  #disposed = false
  #skills: SkillList = null
  #skillsReported = false

  constructor(sessionId: string, emit: (update: FollowUpdate) => void, deps: FollowerDeps = {}) {
    this.#sessionId = sessionId
    this.#emit = emit
    this.#deps = {
      makeWatcher: deps.makeWatcher ?? createWatcher,
      statSize: deps.statSize ?? defaultStatSize,
      readRange: deps.readRange ?? defaultReadRange,
      exists: deps.exists ?? ((t) => fs.existsSync(t)),
    }
    this.#onSkills = deps.onSkills
  }

  get target(): string | null {
    return this.#target
  }

  /**
   * 指向一份紀錄。同一個路徑重複呼叫是無操作 —— 事件橋接每一則事件都帶著位置，
   * 而絕大多數時候它沒有變。
   */
  relocate(target: string): void {
    if (this.#disposed || target === this.#target) return
    this.#target = target
    this.#state = initialFollowState()
    this.#attached = false
    this.#closeWatchers()
    this.#watchDir(path.dirname(target))
    this.#pump(true)
  }

  /** **只由 session 自身的結束呼叫。** 見類別註解。 */
  dispose(): void {
    this.#disposed = true
    this.#closeWatchers()
  }

  #closeWatchers(): void {
    for (const w of [this.#dirWatcher, this.#fileWatcher]) {
      if (!w) continue
      void w.close().catch(() => {
        // 關閉失敗不影響其他 session，也沒有可供使用者處置的動作。
      })
    }
    this.#dirWatcher = null
    this.#fileWatcher = null
  }

  /**
   * 第一層：等紀錄出現。
   *
   * **必須監看一個「已經存在」的目錄。** 一個新 session 的專案目錄可能還不存在（該 repo 從未
   * 跑過 agent），而 chokidar 對一個父目錄也不存在的目標**無從 attach** —— 那正是
   * `branch-service` 監看 `.git/HEAD` 學到的同一條。
   *
   * 失效方式是靜默的：watcher 建得起來、不報錯、永遠不觸發。使用者看到的是「內容不會自己更新，
   * 切走再切回才有」—— 因為切回會重跑一次 `relocate()`，而那條路徑是主動讀取的。
   *
   * 因此往上走到最近一個存在的祖先。目錄出現之後，事件會讓我們重新評估並把監看下移。
   */
  #watchDir(dir: string): void {
    let existing = dir
    for (let i = 0; i < 8 && !this.#deps.exists(existing); i += 1) {
      const parent = path.dirname(existing)
      if (parent === existing) break
      existing = parent
    }
    const watcher = this.#deps.makeWatcher({
      target: existing,
      label: `transcript-dir:${this.#sessionId}`,
      depth: 0,
    })
    watcher.on('all', () => {
      // 監看的若還不是目標所在的目錄，而它現在出現了 ⇒ 把監看下移。
      if (existing !== dir && this.#deps.exists(dir)) {
        this.#dirWatcher = null
        void watcher.close().catch(() => {})
        this.#watchDir(dir)
      }
      this.#pump(false)
    })
    this.#dirWatcher = watcher
  }

  /**
   * 主動讀一次。
   *
   * **監看負責延遲，這個負責保證。** 監看有一整類靜默的失效方式（目標尚不存在、網路檔案系統、
   * inode 被換掉），而它們的共同徵狀都是「畫面安靜地停住」—— 而本 change 的 design 已經寫明
   * 那比沒有 view 更糟。呼叫端在對話 view 開著時定期呼叫它，成本是一次 `stat`。
   */
  poll(): void {
    this.#pump(false)
  }

  #watchFile(target: string): void {
    if (this.#fileWatcher) return
    const watcher = this.#deps.makeWatcher({ target, label: `transcript:${this.#sessionId}` })
    watcher.on('all', () => this.#pump(false))
    this.#fileWatcher = watcher
  }

  /** 讀一輪。**任何失敗都只影響這個 session** —— 不拋出、不波及 pty。 */
  #pump(initial: boolean): void {
    if (this.#disposed || !this.#target) return
    const target = this.#target

    const size = this.#deps.statSize(target)
    if (size === null) {
      // **尚不存在 ＝ 尚無內容，不是「跟進中」也不是失敗。** agent 在使用者講第一句話之前
      // 不會寫出任何東西，因此這是**每一個新 session 的必經狀態**，不是例外。
      //
      // 早期版本在這裡回報「跟進中」，而呈現層把它當成一個整頁的載入狀態 —— 於是新 session
      // 的輸入框被吃掉，使用者打不了字；打不了字紀錄就永遠不會出現。**那是一個死鎖**，
      // 而規格本來就寫著「呈現層收到『尚無內容』而非錯誤」。
      if (initial) {
        this.#publish('ok', [], false, true)
        this.#setSkills(null)
      }
      return
    }
    this.#watchFile(target)

    const plan = planRead(this.#state, size)
    if (plan.kind === 'idle') {
      if (initial) {
        this.#publish('ok', [], false, true)
        this.#setSkills(null)
      }
      return
    }
    const reset = plan.kind === 'reset'
    const from = reset ? 0 : plan.from
    const chunk = this.#deps.readRange(target, from, size)
    if (chunk === null) {
      // 讀得到大小卻讀不到內容 —— 權限或 I/O。**明說**，不要靜默呈現為「沒有內容」。
      this.#publish('unavailable', [], false, true)
      return
    }

    const next = consume(reset ? initialFollowState() : this.#state, chunk, reset)
    this.#state = next.state
    // Parsed once, then projected and folded: the listing is not a view event. A first read (a relocation
    // included: `/clear` moves to a transcript with its own listing) starts from no list.
    const records = next.lines.map(parseLine)
    const events = records.flatMap(project)
    this.#setSkills(foldSkills(reset || !this.#attached ? null : this.#skills, records))

    if (!this.#attached || reset) {
      this.#attached = true
      const attachment: Attachment = attachmentOf(events)
      this.#publish('ok', attachment.events, attachment.truncated, true)
      return
    }
    if (events.length > 0) this.#publish('ok', events, false, false)
  }

  #setSkills(next: SkillList): void {
    const changed = !this.#skillsReported || !sameSkills(this.#skills, next)
    this.#skills = next
    if (!changed || !this.#onSkills) return
    this.#skillsReported = true
    this.#onSkills(next)
  }

  #publish(status: FollowStatus, events: ViewEvent[], truncated: boolean, reset: boolean): void {
    this.#emit({ sessionId: this.#sessionId, status, events, truncated, reset })
  }
}
