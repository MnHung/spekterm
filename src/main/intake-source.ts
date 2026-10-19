import fs from 'node:fs'
import path from 'node:path'
import type { FSWatcher } from 'chokidar'

import { createWatcher, type CreateWatcherOptions } from './watcher'
import { isPermanentRejection } from './intake-rejection'
import type { DeliverOutcome, IntakeService } from './intake-service'

/**
 * 檔案落點 —— `deliver()` 的 adapter。
 *
 * ## 兩個入口，而第二個是承重的
 *
 * 1. **建立監看並等它就緒**，2. **再掃描落點既有的內容**。
 *
 * 這個順序會讓中間抵達的檔案被處理兩次 —— **而那是可接受的**，去重的權威是狀態 index，
 * 且內容相同的重複是靜默的。相反的順序會**漏掉**中間抵達的檔案，而漏掉是靜默的。
 *
 * **「等它就緒」不是多餘的一步，少了它有一個會永久遺漏的窗口**（實測）：chokidar 在
 * `ready` 之前看到的檔案一律視為「初始」，而 `ignoreInitial: true` 會把它們全部吞掉。
 * 於是一份在「建立監看」與「掃描」之間抵達的投遞，**兩邊都收不到** —— 監看當它是初始、
 * 掃描還沒跑到那裡。先等 `ready` 再掃，這個窗口就不存在：`ready` 之前的由掃描負責，
 * `ready` 之後的由事件負責，兩者重疊的部分由去重吸收。
 *
 * **少了掃描，整條管線在它最主要的情境下失效**：`createWatcher` 的 `ignoreInitial: true`
 * 是寫死且不可覆寫的（`watcher.ts`），於是「app 關著的時候投遞」—— 正是外部 producer 存在的
 * 理由 —— 的東西會永遠躺在落點裡。producer 那端看起來投遞成功，使用者這端看起來沒有人找他，
 * **兩端都沒有錯誤**。
 *
 * 這與 `branch-service` / `openspec-service` 是同一個模式：**初始狀態自己求，watcher 只接後續**。
 *
 * ## The third entry point: the periodic re-read
 *
 * **The watcher is an accelerator, not the guarantee.** In dogfood it silently missed one session's
 * outbox; every handoff into it vanished until a restart, and nothing reported an error (issue #48).
 * The cause was never found, and a watcher can miss a directory for reasons we cannot list in
 * advance. So the drop point is also re-read every `RESCAN_INTERVAL_MS`.
 *
 * - **It starts before `ready`**, and keeps running if the startup scan throws. A watcher that never
 *   becomes ready is one of the failures it exists for. Overlap with the startup scan and the
 *   watcher is absorbed the same way the startup scan / watcher overlap already is.
 * - **It skips a file whose re-read would repeat something**, while the file is unchanged since it
 *   was handled (`#handled`): a visible rejection that left it behind (the inbox is full — its trace
 *   would count again every tick), a delivery that threw (an in-process retry can meet its own
 *   half-applied first attempt and be taken for a duplicate), a removal that failed (its whole
 *   outcome, OS notification included, would repeat). **Except** a full-inbox file once the inbox
 *   has room: that retry is what the spec promises. Files left with nothing visible (unparseable,
 *   capability off) are not recorded — reading them again is free.
 * - **Only the re-read consults the record.** The startup scan, `endSession`'s scan, and watcher
 *   events handle whatever they see, as before.
 * - **Not "scan once after preparing an outbox"** (the first idea in issue #48): the outbox is
 *   prepared at spawn, before the agent has written anything, so that scan always finds nothing.
 *
 * ## 監看必須同時收 `add` 與 `change`
 *
 * 「寫到一半的項目不被消費，補完之後仍被採納」是一條 requirement，而補寫發生在**同一個路徑**
 * 上 —— 它不會再產生一次 `add`。只訂 `add` 的實作，其症狀是「補完之後那則永遠不出現，
 * 直到下次重啟」。
 *
 * ## 為什麼要分批
 *
 * 關機一週累積的 backlog 會在開機那一刻全部落在啟動掃描上。**投遞的處理不得阻塞主行程** ——
 * 主行程失去回應的代價是整個工作台卡住，而主行程結束時所有 pty 一併死亡。
 * 因此每一批之間讓出 event loop，**而不是用「速率上限」把 backlog 拒絕掉**（那會在開機那一刻
 * 吃掉一整週的合法投遞）。
 */

/** 只採納這個副檔名。**這是縮小窗口，不是防護** —— 見 design D1。 */
const ACCEPTED_EXTENSION = '.json'

/** 單檔大小上限。超限者**不解析** —— 解析一份無上限的輸入會讓主行程失去回應。 */
export const MAX_DELIVERY_BYTES = 512 * 1024

/** 啟動掃描的批次大小。每批之間讓出 event loop。 */
const SCAN_BATCH = 20

/** How often the drop point is re-read. See the header, "The third entry point". */
export const RESCAN_INTERVAL_MS = 30_000
/** The spec's bound: a delivery is processed within one minute of being written. */
const MAX_RESCAN_INTERVAL_MS = 60_000

export type WatcherFactory = (options: CreateWatcherOptions) => FSWatcher

/** What came of reading one file: a delivery's outcome, or a delivery that threw. */
export type SourceOutcome = DeliverOutcome | { failed: true }

export function inboxRoot(userDataPath: string): string {
  return path.join(userDataPath, 'intake-inbox')
}

/** The `(mtimeMs, size)` a file had when it was read — what the re-read record compares. */
export interface FileState {
  mtimeMs: number
  size: number
}

/**
 * 讀一份投遞。**大小檢查兩次**：`stat` 在前（省掉整份讀取），讀回的長度在後（擋邊讀邊長）。
 * 超限回 `tooLarge`，呼叫端據此消費掉它。
 *
 * It returns the `stat` it took. The re-read record must hold the state of the version that was
 * **handled** — a second `stat` afterwards could see a newer version that never was.
 */
async function readBounded(
  file: string,
): Promise<{ contents: string; state: FileState } | { tooLarge: true; state: FileState } | null> {
  let stats: fs.Stats
  try {
    stats = await fs.promises.stat(file)
  } catch {
    return null
  }
  if (!stats.isFile()) return null
  const state = { mtimeMs: stats.mtimeMs, size: stats.size }
  if (stats.size > MAX_DELIVERY_BYTES) return { tooLarge: true, state }

  let contents: string
  try {
    contents = await fs.promises.readFile(file, 'utf8')
  } catch {
    return null
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_DELIVERY_BYTES) return { tooLarge: true, state }
  return { contents, state }
}

export interface IntakeSourceOptions {
  root: string
  adapter: string
  service: IntakeService
  /** 供測試觀察每一次處理的結果。 */
  onProcessed?: (file: string, consumed: boolean) => void
  /**
   * 落點的層數。`0` ＝ 扁平（共用投遞落點），`1` ＝ 每個來源一層子目錄（交接的落點）。
   *
   * **監看與掃描兩邊都要吃它，而漏掉監看那一邊的失效特別惡劣**：啟動掃描照常運作，只有
   * watcher 收不到事件 —— 症狀是「即時不進來、重啟才出現」，看起來完全像一個時序問題。
   */
  depth?: number
  /**
   * 如何把一份讀回來的內容變成一次投遞。預設是 `service.deliver(contents, adapter)`。
   *
   * **它存在是因為有些 adapter 的投遞帶著只有接收端算得出來的參數** —— 交接的來源由它落在
   * 哪個子目錄決定、目標由查表解析，兩者都**不能**是投遞內容裡的欄位（否則任何放進落點的
   * 檔案都能自選 folder）。於是那些值只能經這條路徑以參數供應。
   */
  /**
   * `state` is the stat the read took. An adapter that needs the file's time takes it from here, not from a second
   * `stat` that could see a newer file at the same path, or none (`agent-session-control` D6).
   */
  deliver?: (contents: string, file: string, state: FileState) => Promise<DeliverOutcome>
  /**
   * 這個落點的**永久性**失敗要不要讓使用者立刻知道（作業系統通知）。
   *
   * **預設為否** —— 「被拒絕的投遞 SHALL NOT 發出作業系統通知」是共用落點的規則：
   * 投遞者控制數量，而使用者的注意力有限。
   *
   * **交接是那條規則明文的例外**，而例外的理由不在這裡：那條路徑上沒有人在等著按接受，
   * 於是「使用者剛剛交辦、agent 回報已交出、實際上什麼都沒發生」與成功在畫面上完全相同。
   *
   * **接線在這裡而不在 `HandoffService`，是因為兩條拒絕路徑只有這裡都經過。**
   * 超過檔案大小上限的投遞在 `readBounded` 就被擋下並消費掉，它**永遠不會走到** `deliver`
   * —— 把接線放在 adapter 的 `deliver` 裡，`TOO_LARGE` 就結構上通知不出來。
   */
  notifyFailures?: boolean
  /**
   * Told what came of every file read, **before** the file is removed (`handoff-receipt`): the deliver path, the
   * oversize path, and a delivery that threw (`{ failed: true }`). Awaited; **its own failure is logged and
   * processing goes on** — a receipt that cannot be written must not hold a delivery back. Not called for a
   * dot-prefixed file, which is not read.
   */
  onOutcome?: (file: string, outcome: SourceOutcome) => Promise<void> | void
  /** **Tests only.** Replaces the watcher, to reproduce one that reports nothing. */
  watch?: WatcherFactory
  /** **Tests only.** Told when each periodic re-read starts and ends. */
  onRescan?: (phase: 'start' | 'end') => void
  /**
   * The re-read interval. Exists so its validation can be tested; callers use the default.
   * Must be finite and within `(0, 60 000]` — Node runs `0` and `Infinity` every millisecond.
   */
  rescanIntervalMs?: number
}

export class IntakeSource {
  #watcher: FSWatcher | null = null
  readonly #root: string
  readonly #adapter: string
  readonly #service: IntakeService
  readonly #onProcessed?: (file: string, consumed: boolean) => void
  readonly #depth: number
  readonly #deliver: (contents: string, file: string, state: FileState) => Promise<DeliverOutcome>
  readonly #notifyFailures: boolean
  readonly #watch: WatcherFactory
  readonly #onRescan?: (phase: 'start' | 'end') => void
  readonly #onOutcome?: (file: string, outcome: SourceOutcome) => Promise<void> | void
  readonly #rescanIntervalMs: number
  /**
   * Files being handled right now, and the handling. `scan()` awaits an entry instead of skipping
   * it: `endSession` scans and then deletes the outbox, and a file the re-read is in the middle of
   * would otherwise be deleted under it.
   */
  #inflight = new Map<string, Promise<void>>()
  /**
   * Files still on disk whose re-read would repeat something, with the state they were handled at.
   * Only the periodic re-read consults it — see the header, "The third entry point".
   */
  #handled = new Map<string, FileState & { capacity: boolean }>()
  #timer: NodeJS.Timeout | null = null
  #rescanning = false

  constructor({
    root,
    adapter,
    service,
    onProcessed,
    depth = 0,
    deliver,
    notifyFailures = false,
    watch = createWatcher,
    onRescan,
    onOutcome,
    rescanIntervalMs = RESCAN_INTERVAL_MS,
  }: IntakeSourceOptions) {
    if (!Number.isFinite(rescanIntervalMs) || rescanIntervalMs <= 0 || rescanIntervalMs > MAX_RESCAN_INTERVAL_MS) {
      throw new RangeError(`rescan interval must be within (0, ${MAX_RESCAN_INTERVAL_MS}] ms: ${rescanIntervalMs}`)
    }
    this.#root = root
    this.#adapter = adapter
    this.#service = service
    this.#onProcessed = onProcessed
    this.#depth = depth
    this.#deliver = deliver ?? ((contents) => this.#service.deliver(contents, this.#adapter))
    this.#notifyFailures = notifyFailures
    this.#watch = watch
    this.#onRescan = onRescan
    this.#onOutcome = onOutcome
    this.#rescanIntervalMs = rescanIntervalMs
  }

  /** Tell `onOutcome`, never throwing: a failed receipt is logged and the file is still processed. */
  async #told(file: string, outcome: SourceOutcome): Promise<void> {
    if (!this.#onOutcome) return
    try {
      await this.#onOutcome(file, outcome)
    } catch (error) {
      console.error(`[intake] outcome hook failed for ${file}: ${String(error)}`)
    }
  }

  /**
   * 一次拒絕之後：**永久性的**才回報出去。
   *
   * 暫時性的（寫到一半、收件匣已滿、某個功能被關閉）不回報 —— 那類項目會在每次補寫或重試
   * 時再次被讀到，逐次通知沒有上界，而合併只防批次、不防節奏。
   */
  #reportIfPermanent(outcome: DeliverOutcome): void {
    if (!this.#notifyFailures) return
    if (outcome.ok || !outcome.code) return
    if (!isPermanentRejection({ code: outcome.code, notify: outcome.notify })) return
    this.#service.reportFailure({
      code: outcome.code,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      ...outcome.failure,
      at: Date.now(),
    })
  }

  /**
   * mkdir → 建立監看 → **start the periodic re-read** → 等監看就緒 → 掃描既有內容。
   * **順序是承重的，見檔頭。** The re-read starts before `ready` on purpose: a watcher that never
   * becomes ready, or a startup scan that throws, must not leave the drop point unread.
   */
  async start(): Promise<void> {
    await fs.promises.mkdir(this.#root, { recursive: true })

    this.#watcher = this.#watch({
      target: this.#root,
      label: this.#root,
      // 一對一監看：**不傳 `pollingRoot`**（那是給服務多目標的 watcher 的例外）。
      // 深度由呼叫端決定：共用落點是扁平的（`0`），交接的落點每個來源一層（`1`）。
      depth: this.#depth,
    })
    // **`add` 與 `change` 都要**：補寫發生在同一個路徑上，不會再產生一次 `add`。
    this.#watcher.on('add', (file) => void this.#handle(file))
    this.#watcher.on('change', (file) => void this.#handle(file))

    this.#timer = setInterval(() => this.#tick(), this.#rescanIntervalMs)
    this.#timer.unref()

    // 見檔頭：`ready` 之前抵達的檔案會被 `ignoreInitial` 吞掉，而它們也還沒被掃描看到。
    await new Promise<void>((resolve) => {
      this.#watcher?.once('ready', () => resolve())
    })

    await this.scan()
  }

  /** 掃描落點既有的內容。**分批，每批之間讓出 event loop。** Does not consult the re-read record. */
  async scan(): Promise<void> {
    const files = await this.#collect(this.#root, this.#depth)
    for (let i = 0; i < files.length; i += SCAN_BATCH) {
      const batch = files.slice(i, i + SCAN_BATCH)
      for (const file of batch) await this.#handle(file)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /** One interval tick. Skipped while the previous re-read is still running; never throws. */
  #tick(): void {
    if (this.#rescanning) return
    this.#rescanning = true
    this.#onRescan?.('start')
    void this.#rescan()
      .catch((error: unknown) => console.error(`[intake] re-read failed ${this.#root}: ${String(error)}`))
      .finally(() => {
        this.#rescanning = false
        this.#onRescan?.('end')
      })
  }

  /**
   * The periodic re-read: every file, except one recorded in `#handled` and unchanged since — unless
   * it was held back by a full inbox that now has room. A file already being handled is left to its
   * handler.
   */
  async #rescan(): Promise<void> {
    const readDirs = new Set<string>()
    const files = await this.#collect(this.#root, this.#depth, readDirs)

    // Forget files that are gone — but only under directories that were actually read: a failed
    // `readdir` (EMFILE) returns nothing, and that is not "everything was removed".
    const present = new Set(files)
    for (const recorded of this.#handled.keys()) {
      if (readDirs.has(path.dirname(recorded)) && !present.has(recorded)) this.#handled.delete(recorded)
    }

    for (let i = 0; i < files.length; i += SCAN_BATCH) {
      for (const file of files.slice(i, i + SCAN_BATCH)) {
        if (this.#inflight.has(file)) continue
        if (await this.#unchangedSinceHandled(file)) continue
        await this.#handle(file)
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  async #unchangedSinceHandled(file: string): Promise<boolean> {
    const recorded = this.#handled.get(file)
    if (!recorded) return false
    if (recorded.capacity && this.#service.hasRoom()) return false
    let stats: fs.Stats
    try {
      stats = await fs.promises.stat(file)
    } catch {
      return false
    }
    return stats.mtimeMs === recorded.mtimeMs && stats.size === recorded.size
  }

  /**
   * 收集落點中的候選檔案，最多下探 `depth` 層。
   *
   * **只在 `dirent.isDirectory()` 為真時下鑽** —— 不跟隨 symlink 目錄，與 `listFiles` 的手寫
   * 遞迴同一條理由（`fs.readdirSync` 與 `fs/promises.readdir` 對 `{ recursive: true }` 的行為
   * 不一致，而那個差異未見於文件）。
   *
   * `readDirs`, when given, collects the directories whose `readdir` succeeded.
   */
  async #collect(dir: string, depth: number, readDirs?: Set<string>): Promise<string[]> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    readDirs?.add(dir)
    const files: string[] = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth > 0) files.push(...(await this.#collect(full, depth - 1, readDirs)))
        continue
      }
      if (entry.isFile()) files.push(full)
    }
    return files
  }

  async dispose(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await this.#watcher?.close()
    this.#watcher = null
  }

  /** Record a file whose re-read would repeat something, at the state it was handled. */
  #remember(file: string, state: FileState, capacity: boolean): void {
    this.#handled.set(file, { ...state, capacity })
  }

  /**
   * Remove a consumed file. **A failure is logged, not thrown**, and the file recorded: otherwise
   * every re-read repeats its whole outcome (on the handoff path, an OS notification), and before
   * this the error escaped `start()`.
   */
  async #remove(file: string, state: FileState): Promise<void> {
    try {
      await fs.promises.rm(file, { force: true })
      this.#handled.delete(file)
    } catch (error) {
      console.error(`[intake] could not remove ${file}: ${String(error)}`)
      this.#remember(file, state, false)
    }
  }

  #handle(file: string): Promise<void> {
    if (!file.endsWith(ACCEPTED_EXTENSION)) return Promise.resolve()
    /**
     * **以點開頭的一律跳過** —— 那是「還沒寫完」的慣例。
     *
     * 只看副檔名是不夠的：producer 依指示「先寫暫存檔再改名」時，它挑的暫存檔名很可能仍以
     * `.json` 結尾（實測：agent 取的是 `.tmp-<x>.json`）。於是我們會把一份**寫到一半**的檔案
     * 當成正式投遞讀走，而更糟的是**它若恰好解析成功就會被消費掉** —— 與 producer 的改名互相
     * 競爭，結果不可預測。
     *
     * **這道守衛不倚賴 producer 照著做。** 指示仍然會說「暫存檔名不要以 `.json` 結尾」，但
     * 一個依賴對方守規矩的協定不是協定 —— 尤其對方是一個 agent。
     */
    if (path.basename(file).startsWith('.')) return Promise.resolve()
    const running = this.#inflight.get(file)
    if (running) return running
    const handling = this.#process(file).finally(() => this.#inflight.delete(file))
    this.#inflight.set(file, handling)
    return handling
  }

  async #process(file: string): Promise<void> {
    const read = await readBounded(file)
    if (read === null) return
    if ('tooLarge' in read) {
      // 永久性拒絕：大小不會自己變小。拒絕的**呈現**仍經 service，於是它與其餘拒絕
      // 共用同一份合併與上限（「面向使用者的拒絕與警示 SHALL 有界」）。
      const oversize = this.#service.rejectOversize(path.basename(file), { adapter: this.#adapter })
      this.#reportIfPermanent(oversize)
      await this.#told(file, oversize)
      await this.#remove(file, read.state)
      this.#onProcessed?.(file, true)
      return
    }
    // **失敗必須說話。** 少了這個 catch，一個投遞失敗會變成未捕捉的 rejection：
    // 投遞檔留在落點、收件匣空著、而畫面上與 log 裡都沒有任何線索
    //（dogfood 第一次投遞就踩到 —— 保存處的目錄尚未建立）。
    let outcome
    try {
      outcome = await this.#deliver(read.contents, file, read.state)
    } catch (error) {
      console.error(`[intake] delivery failed ${file}: ${String(error)}`)
      await this.#told(file, { failed: true })
      // Recorded, so the re-read does not retry it in this process: the store changes memory
      // before it saves, so a retry could meet its own half-applied first attempt and be taken
      // for a same-content duplicate — consumed silently. It is retried at the next start (as
      // before) or when the file changes.
      this.#remember(file, read.state, false)
      return
    }
    this.#reportIfPermanent(outcome)
    await this.#told(file, outcome)
    if (outcome.consume) await this.#remove(file, read.state)
    // Left behind **and visible** (today: the inbox is full) ⇒ recorded, so the re-read does not
    // count its trace again. Left behind with nothing visible (unparseable, capability off) ⇒ not
    // recorded: reading it again is free, and it must be picked up as soon as it becomes valid.
    else if (outcome.notify) this.#remember(file, read.state, outcome.code === 'CAPACITY')
    else this.#handled.delete(file)
    this.#onProcessed?.(file, outcome.consume)
  }
}
