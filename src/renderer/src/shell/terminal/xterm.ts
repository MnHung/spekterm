import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { pickUnicodeVersion } from './unicode-width'

/**
 * xterm 的唯一 wrapper 模組 —— 比照編輯器的約束（`workspace-app-shell` 的「編輯器透過
 * wrapper 介面存取」）：renderer 的其他模組一律不直接 import `@xterm/*`，退守替代終端時
 * 改動侷限於此。
 *
 * 這裡不碰 IPC、不碰 React：只把 xterm 三件套（Terminal + fit + web-links）組裝成一個
 * 好操作的把手，並確保連結點擊不由 xterm 自行導航（design D13）。
 */

/** 對齊 app 的深色主題與 mockup 的終端配色（--color-shell / ink-dim / accent）。 */
const THEME = {
  background: '#07090c',
  foreground: '#94a3b8',
  cursor: '#f59e0b',
  cursorAccent: '#07090c',
  selectionBackground: '#243044',
} as const

export interface XtermHandle {
  /** 掛載到 DOM。回傳之後才量得到尺寸。 */
  open(parent: HTMLElement): void
  /** 依容器尺寸重排。回傳新的 cols/rows；尺寸未變或容器不可見時回傳 null。 */
  fit(): { cols: number; rows: number } | null
  /**
   * 當前的 cols/rows —— **不重新量測，也不做「尺寸有沒有變」的偵測**。
   *
   * `fit()` 在尺寸未變時回 `null`（它的用途是「要不要打擾 pty」），因此它**沒辦法**回答
   * 「把現在的尺寸告訴一個**剛誕生**的 pty」。喚醒一個休眠的 session 時正是這個處境。
   */
  size(): { cols: number; rows: number }
  write(data: string): void
  /** 使用者鍵入的出口。回傳解除訂閱的函式。 */
  onInput(listener: (data: string) => void): () => void
  /**
   * pty 內的程式以 OSC 序列（`ESC ] 0 ; <title> BEL`）設定的終端標題。
   *
   * 這是程式**主動宣告的身分**（`claude` 就是這樣讓終端模擬器的分頁自動改名的），
   * 不是我們去猜的。回傳解除訂閱的函式。
   */
  onTitle(listener: (title: string) => void): () => void
  /**
   * 把當前畫面序列化成一段可以再寫回去的文字（含跳脫序列）。用於重開 app 後還原畫面。
   *
   * 只取最後 `SNAPSHOT_LINES` 行 —— 快照要落到磁碟上，而 scrollback 有 5000 行，一個 SGR
   * 密集的 agent 輸出序列化出來會非常大。
   */
  serialize(): string
  /**
   * 重播上次的畫面，接著寫入一段分隔，完成後呼叫 `done`。
   *
   * **不能只是 `write(history + separator)`。** `SerializeAddon` 的輸出**結尾帶一個絕對的游標定位**
   * （把游標還原到快照當下的位置）—— 而那個位置對一個「即將接上新 pty」的終端毫無意義：實測新
   * shell 的 prompt 會直接**蓋掉歷史中間的某一行**（探針抓到 `$ RK_42` —— `MARK_42` 的前兩個字
   * 被 `$ ` 覆寫掉了）。
   *
   * 因此重播完要把游標挪到**內容之後**再寫分隔，而且只用相對移動（`\n` 會正確捲動，絕對定位不會）。
   * `done` 必須等到分隔也寫完才呼叫 —— 呼叫端要在那之後才接上 live 串流，否則 pty 的第一個
   * prompt 會插進歷史裡。
   */
  replay(history: string, separator: string, done: () => void): void
  /** 目前選取的內容（xterm 的選取不是 DOM selection，瀏覽器原生的複製抓不到它）。 */
  getSelection(): string
  hasSelection(): boolean
  /** 把文字送進 pty。xterm 會處理 bracketed paste（程式若啟用了它）。 */
  paste(text: string): void
  /**
   * 套用終端字型偏好。`null` 代表該欄未設定 —— family 退回系統等寬字、size 退回字級尺度的預設、
   * lineHeight 退回預設行高。
   *
   * **回傳「是否真的改動了 xterm 的選項」** —— 沒改動時呼叫端就不該 `fit()`／`resize()`：那會對 pty
   * 多送一次無謂的 SIGWINCH，而 shell 收到它會重畫 prompt（實測：掛載時無條件 resize 會把終端既有的
   * 輸出往上推，探針「切回 session 後其先前的輸出仍在」因此讀不到早期的內容）。
   *
   * 有改動時，由呼叫端在其後 `fit()` 並把新的行列數告知 pty（字級與行高都會改 cell 尺寸）。
   */
  setFont(font: { family: string | null; size: number | null; lineHeight: number | null }): boolean
  /**
   * 開／關 GPU 加速（webgl renderer）。回傳它**當下是否啟用**。
   *
   * **只給使用者當下看得見的那一個終端**，切走即關 —— 這不是優化，是正確性要求：所有 session 的
   * 終端同時掛載（各自保留 scrollback），而並存的 webgl context 有上限（**實測恰為 16**），
   * **超出時最舊的會被靜默丟棄 —— 不觸發任何事件**（實測建 30 個只有 16 個活著，
   * `webglcontextlost` 一次都沒觸發）。於是較舊的終端會**無聲地變成空白**，而下面那條
   * `onContextLoss` 的自癒**救不了它**（它倚賴一個通知，而那裡根本沒有通知）。並存恆為 1，
   * 就永遠碰不到上限。
   *
   * 取不到 context（headless／軟體渲染／驅動問題）時**退回 DOM renderer**，不拋錯 —— 至少不比
   * 現況差。
   */
  setGpuRenderer(enabled: boolean): boolean
  focus(): void
  dispose(): void
}

/**
 * 複製／貼上的快捷鍵。
 *
 * **`Ctrl+C` 不在其中，而且不能在。** 終端裡的 `Ctrl+C` 是中斷訊號 —— agent 跑失控時要
 * 中斷它的能力，不能因為畫面上剛好有一段選取就失靈。這正是終端模擬器普遍採用
 * `Ctrl+Shift+C` 的理由。macOS 的 `Cmd+C` 不與中斷訊號衝突，故該平台用 `Cmd`（design D3）。
 */
function matchClipboardKey(event: KeyboardEvent): 'copy' | 'paste' | null {
  const isMac = navigator.platform.toUpperCase().includes('MAC')
  const modifier = isMac ? event.metaKey : event.ctrlKey && event.shiftKey
  if (!modifier) return null

  const key = event.key.toLowerCase()
  if (key === 'c') return 'copy'
  if (key === 'v') return 'paste'
  return null
}

export interface XtermOptions {
  /** 點到連結。wrapper 不認得 `workspace.shell` —— 它只把 URI 交出去。 */
  openLink: (uri: string) => void
  /** 使用者以快捷鍵要求複製。`text` 是當下的選取內容（非空才會呼叫）。 */
  onCopy: (text: string) => void
  /** 使用者以快捷鍵要求貼上。呼叫端負責讀剪貼簿，再呼叫 `paste()`。 */
  onPaste: () => void
}

/**
 * 建立一個終端把手。所有與外界的接觸（開連結、讀寫剪貼簿）都由呼叫端注入 —— wrapper 不認得
 * `workspace.*`，信任決策留在這道接縫之外。
 */
/**
 * 終端的字級。
 *
 * xterm 的 `fontSize` 是數字（它用 canvas 量測 cell 尺寸），吃不到 CSS token —— 因此從
 * `--text-terminal` 讀出來再交給它。等寬字在相同 px 下的視覺比例與比例字不同，故終端自成
 * 一級；但那一級仍由 `--text-base` 這個旋鈕推導，不是一個與字級尺度無關的常數。
 *
 * **不能直接讀那個自訂屬性（實測，而且它會靜默失敗）**：CSS 自訂屬性的 computed value
 * **不會求值 `calc()`** —— `getPropertyValue('--text-terminal')` 回傳的是字面的
 * `"calc(15px - 1px)"`，`parseFloat` 於是得到 `NaN`，悄悄退回下面那個 fallback。因為 fallback
 * 剛好等於當時的正確值，畫面上完全看不出來：終端的字級從此與尺度脫鉤，旋鈕轉了它也不動。
 *
 * 解法是讓**瀏覽器**去求值：`font-size` 是有型別的屬性，它的 computed value 一定是絕對 px。
 * 把 `var(--text-terminal)` 餵給一個離屏元素的 `font-size`，再讀回它 computed 的 `fontSize`。
 */
const TERMINAL_FONT_SIZE_FALLBACK = 14

function terminalFontSize(): number {
  const probe = document.createElement('div')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.fontSize = 'var(--text-terminal)'
  document.body.appendChild(probe)
  const px = Number.parseFloat(getComputedStyle(probe).fontSize)
  probe.remove()

  // 終端字級是使用者最常盯著的東西 —— 變數若不見了，也不能變成瀏覽器預設的 16px 或 0。
  return Number.isFinite(px) && px > 0 ? px : TERMINAL_FONT_SIZE_FALLBACK
}

/**
 * 未設定字型偏好時的預設字型鏈。
 *
 * **刻意不寫任何特定字型名**（先前首選 `'JetBrains Mono'` 這台機器沒裝、專案也沒打包，於是靜默
 * 落到系統預設等寬字）。`ui-monospace` 在 macOS 解析為 SF Mono，在 Linux 落到 `monospace`（系統
 * 預設等寬字）—— 預設的職責只是「是一個**真實存在**的等寬字，開箱不破」；與使用者終端一致由使用者
 * 設定偏好達成（design D3）。使用者設定的 family 會前置於這條鏈之前，鏈本身作為缺字時的退路。
 */
const DEFAULT_FONT_FAMILY = 'ui-monospace, monospace'

/**
 * 未設定偏好時的行高。**1.0，而非先前的 1.3。**
 *
 * xterm 的 DOM renderer 下，框線字元（`│` `┌` …）是**靠字型自己的 glyph 去拼**的，而 glyph 只有約
 * 1em 高，row 的高度卻是 `fontSize × lineHeight` —— 行高大於 1 時，上下兩列的 `│` 接不起來，中間留
 * 一條縫，表格看起來就是破的。**這是 dogfood 回報「表格破版」的主因之一**（實測：1.3 → 1.0 之後
 * 「好不少」）。
 *
 * 行高因此不只是可讀性，它是框線能不能接起來的前提。使用者仍可用偏好調整（有人偏好鬆一點的行距，
 * 代價是框線的縫）。
 */
const DEFAULT_LINE_HEIGHT = 1.0

/**
 * 快照保留的行數。xterm 的 scrollback 是 5000 行，但快照要寫進磁碟、每個 session 一份 ——
 * 全部序列化並不划算。1000 行足以讓使用者認出「上次做到哪」。
 */
const SNAPSHOT_LINES = 1000

/**
 * 重播之後送出的模式重置：**不移動游標**。
 *
 * 快照裡可能殘留滑鼠追蹤（使用者關 app 時正開著 vim 或任何吃滑鼠的 TUI）與 SGR ——
 * `SerializeAddon` **會把終端模式一起序列化**（實測，快照裡真的有 `\x1b[?1049h` 與 `\x1b[?1003h`）。
 * 歷史是死的文字，新的 pty 不該繼承它的狀態。
 *
 * **這裡刻意沒有 `?1049l`** —— 那個要條件式地送（見 `replay`）。
 */
const RESET_MODES = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[0m'

export function createXterm(options: XtermOptions): XtermHandle {
  const { openLink, onCopy, onPaste } = options

  // 字型偏好。`null` ＝該欄未設定 → 退回預設（系統字型 / 字級尺度）。使用者設定的 family 前置於預設鏈
  // 之前作為首選（加引號以容納含空白的字型名，如 `MesloLGS NF`），size 直接覆蓋；未設偏好時 size 仍
  // 由 `terminalFontSize()` 跟隨字級尺度（dev 的 HMR 轉旋鈕即時反映的行為保留）。
  const fontOverride: { family: string | null; size: number | null; lineHeight: number | null } = {
    family: null,
    size: null,
    lineHeight: null,
  }
  const resolveFamily = (): string =>
    fontOverride.family ? `"${fontOverride.family}", ${DEFAULT_FONT_FAMILY}` : DEFAULT_FONT_FAMILY
  const resolveSize = (): number => fontOverride.size ?? terminalFontSize()
  const resolveLineHeight = (): number => fontOverride.lineHeight ?? DEFAULT_LINE_HEIGHT

  const term = new Terminal({
    fontFamily: resolveFamily(),
    fontSize: resolveSize(),
    lineHeight: resolveLineHeight(),
    cursorBlink: true,
    // 換行由 pty 內的程式自理，不要 xterm 代為轉換。
    convertEol: false,
    scrollback: 5000,
    // **硬性前提，不是加強**：unicode 版本切換是 xterm 的 proposed API，未開啟時
    // `loadAddon(new UnicodeGraphemesAddon())` **當場拋錯**（實測；它的 `activate()` 內就碰
    // `terminal.unicode`），不是延後到讀取時才失敗。於是沒有「載入了但沒生效」的中間狀態 ——
    // 失效方向是吵的，這對我們有利。
    //
    // 代價：這個選項是一刀切的，開了之後 xterm 的**所有** proposed API 都可存取，而 proposed
    // API 依 xterm 的政策可在 minor 版本間改變。緩解有三層（design D2）：xterm 版本本來就釘死；
    // 接觸面收斂在本 wrapper 一處（renderer 其餘模組拿不到 `Terminal` 實例）；升級 xterm 時
    // 「寬度判定仍生效」已納入驗收，該 API 改變的話驗收會紅。
    allowProposedApi: true,
    // **pty 的輸出不得自行改變行列數。**
    //
    // `CSI ? 3 h/l`（DECCOLM，80／132 欄切換）與 `CSI 8 ; rows ; cols t`（XTWINOPS）都能讓
    // **pty 裡的程式**直接改寫終端的幾何，而兩者都 gate 在這個選項上。此前我們靠的是上游的
    // 預設（全 false）—— 而「尺寸只由一次真實量測決定」這條不變式正是建立在它之上：
    // `fit()` 的防護（見下）擋得住 renderer 這一側，擋不住 pty 那一側。
    //
    // 明寫它，是把一個**上游的預設值**變成一份**我們自己的宣告** —— 與 `fit()` 那道防護同一
    // 條教訓：一個倚賴上游實作細節的不變式，不在我們的版控之內（`docs/lessons/terminal.md`）。
    windowOptions: {},
    theme: { ...THEME },
    // OSC 8 escape-sequence 超連結由 xterm 核心的 OscLinkProvider 處理，走 `Terminal.linkHandler`
    // —— 與 WebLinksAddon（純文字 URL）是**兩套**機制。未設 linkHandler 會落入 xterm 內建預設：
    // 一個 `confirm()`（其 URL 文字由不受信任的 pty 輸出控制）+ `window.open()`。導向 `openLink`，
    // 讓兩套連結都匯到同一條 `openExternal`（主行程驗協定）。不設 `allowNonHttpProtocols`
    // （預設 false）：非 http／https 的 URI 根本不會被 OscLinkProvider 建成可點連結（design D4）。
    linkHandler: {
      activate: (_event, uri) => openLink(uri),
    },
  })

  // **字元寬度的判定，必須在任何內容寫入之前就位。** buffer 的 cell 佔用是在寫入的當下決定的，
  // 事後更換判定**不會**重排既有內容 —— 而 `replay()` 會把上次的畫面快照寫回終端。順序錯了的
  // 後果是「歷史是歪的、新輸出是對的」（design D5）。因此這一段排在所有 addon 之前，而整個
  // `createXterm()` 又早於 `open()` 與任何 live 串流。
  term.loadAddon(new UnicodeGraphemesAddon())
  term.unicode.activeVersion = pickUnicodeVersion(term.unicode.versions)

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

  const serializeAddon = new SerializeAddon()
  term.loadAddon(serializeAddon)

  // 覆寫預設的「開新視窗」：pty 的輸出是不受信任的內容（使用者 repo 裡的任何東西都可能
  // 印出一個 URL），絕不讓它直接驅動導航或開窗 —— 一律交給主行程驗證協定後以系統瀏覽器
  // 開啟。與渲染 markdown 連結同源的信任考量（design D13）。
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault()
      openLink(uri)
    }),
  )

  // 回傳 false＝「這個按鍵我們處理了，xterm 不要再送給 pty」。其餘按鍵一律放行 ——
  // **包含 Ctrl+C**，它必須維持中斷訊號（design D3）。
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true

    const action = matchClipboardKey(event)
    if (!action) return true

    // **Handled here, so the browser's default must not run too.** Returning false only tells xterm not
    // to send the key; it does not prevent the default. On macOS an unprevented `Cmd+V` then reaches the
    // Edit menu's Paste role and pastes a second time (measured: a pasted command ran twice).
    event.preventDefault()
    if (action === 'copy') {
      const selection = term.getSelection()
      if (selection) onCopy(selection)
    } else {
      onPaste()
    }
    return false
  })

  let lastCols = 0
  let lastRows = 0

  // 當前的 webgl addon（null＝正在用 DOM renderer）。
  let webgl: WebglAddon | null = null
  /**
   * 當前 webgl renderer 的繪製脈絡與它的釋放介面。
   *
   * **為什麼要在建立時就抓住，而不是釋放時再去找**：所有 session 的終端**同時掛載**（隱藏的
   * 只是加上 `hidden`），因此以 `document` 為範圍的查詢會回傳**另一個、正在顯示**的終端的
   * canvas —— 釋放它等於讓使用者當場看到空白，而那正是「渲染資源只給顯示中的終端」這條規格
   * 要防止的結果本身。終端銷毀那條路更確定：React 的 cleanup 跑在節點移除之後，此時該終端
   * 已脫離文件，查詢**只可能**命中別人的。
   */
  let webglContext: { gl: WebGL2RenderingContext; lose: WEBGL_lose_context } | null = null

  /** 該終端 `.xterm-screen` 底下的 canvas。**查詢根是這個終端自己，不是 `document`**（見上）。 */
  function screenCanvases(): Set<HTMLCanvasElement> {
    const screen = term.element?.querySelector('.xterm-screen')
    return new Set(screen ? [...screen.querySelectorAll('canvas')] : [])
  }

  /**
   * 取得 webgl renderer 剛建立的那個繪製脈絡。
   *
   * **以「這一次新增了哪些節點」為判準（差集），不是以選擇器排除已知的其他 canvas。**
   * 後者是黑名單：`.xterm-screen` 底下日後多一顆節點時它會靜默選錯，而對一個尚未持有脈絡的
   * canvas 查詢脈絡**會當場建立一個新的** —— 一次意在釋放的操作反而多佔一個額度。差集讓這兩種
   * 誤選在結構上都不可能發生。
   */
  function captureWebglContext(
    before: Set<HTMLCanvasElement>,
  ): { gl: WebGL2RenderingContext; lose: WEBGL_lose_context } | null {
    // link layer 帶著自己的 class，且它是 2d；主 canvas 不帶 class。
    const added = [...screenCanvases()].filter((c) => !before.has(c) && !c.classList.contains('xterm-link-layer'))
    const gl = added.length === 1 ? added[0].getContext('webgl2') : null
    const lose = gl?.getExtension('WEBGL_lose_context') ?? null

    if (!gl || !lose) {
      // 靜默的話，「沒抓到」與「正確釋放了」在外部完全無法區分 —— 而那正是本 change 所修的
      // 缺陷的形狀（dispose 看起來做了事，實際沒還額度）。在**取得**的路徑發聲：每次切到該
      // session 都會經過這裡，問題因此反覆可見，而不是只在關閉時出現一次。
      console.warn(
        `[terminal] cannot capture WebGL context for release (added=${added.length}, gl=${!!gl}, ext=${!!lose}); ` +
          'the context will not be released and its slot stays occupied until GC',
      )
      return null
    }
    return { gl, lose }
  }

  /**
   * 歸還並存額度。
   *
   * **順序是 dispose 之後**：`dispose()` 會解除 addon 的 DOM listener，因此這裡不會觸發它的
   * `webglcontextlost` handler。反過來（先 lose 再 dispose）會踩到兩件事：該 handler 排一個
   * **3000ms** 的 timer，而那個 timer **只有 `webglcontextrestored` 會清、`dispose()` 不清** ——
   * 三秒後仍會印訊息，且若使用者在那三秒內切回來，它會把剛建好的新 addon 蓋成 `null`。
   */
  function releaseWebglContext(): void {
    webglContext?.lose.loseContext()
    webglContext = null
  }

  return {
    open(parent) {
      term.open(parent)
    },
    fit() {
      // 字級決定 cell 尺寸，cell 尺寸決定行列數 —— 字級變了而不重新量測，pty 手上的 cols/rows
      // 就與畫面錯位。在這裡（而不是另開一個 API）重新讀取，是因為 fit 本來就在 attach 與
      // 每次 resize 時被呼叫；於是尺度的旋鈕一轉（dev 的 HMR 會即時改寫 CSS 變數），終端
      // 下一次 fit 就跟上，不必重啟。**用 `resolveSize()`**：未設偏好時跟隨尺度，設了則用偏好。
      const fontSize = resolveSize()
      if (fontSize !== term.options.fontSize) term.options.fontSize = fontSize

      // **容器沒有被排版出來時（未顯示的 session、尚未掛載），什麼都不做。**
      //
      // 判準是**容器自己的盒子**，不是 `proposeDimensions()` 的回傳值 —— 後者曾經是對的，
      // 而它被一次純依賴升級靜默地變成錯的（實測，見 `docs/lessons/terminal.md`）：
      //
      // | addon-fit 0.11.0    | `parseInt('auto')` → NaN 一路傳到底 ⇒ `{cols: NaN, rows: NaN}` |
      // | addon-fit 0.12.0-beta | 上游加了 `parseInt(...) \|\| 0` ⇒ 可用空間為負 ⇒ 夾到
      // |                       | `MINIMUM_COLS=2` / `MINIMUM_ROWS=1` ⇒ **`{cols: 2, rows: 1}`** |
      //
      // 於是下面那三道防護（`!proposed`、`Number.isFinite`、`< 1`）**全部放行** ——
      // 終端被重排成 2 欄（既有 scrollback 撞上上限而永久遺失），pty 也真的收到 2 欄
      // （agent 在隱藏期間以 2 欄排版，那些輸出印出去就是壞的）。
      //
      // **不要改成「把 `< 1` 放寬成 `<= MINIMUM_COLS`」**：那是黑名單，而且綁在上游的內部
      // 常數上（同一個成因換個位置重演）；它也分不出「真的只有 2 欄的窄終端」與「沒有盒子」
      // —— 而那兩者的正確處置相反。`display:none` 的元素沒有 box、`clientWidth`／
      // `clientHeight` **依定義為 0**，那是 DOM 的契約，不是某個套件的實作細節。
      //
      // 量的必須是 `term.element.parentElement` —— 也就是 `proposeDimensions()` 讀 computed
      // style 的那同一個元素（`open(parent)` 的 host）。但**同一個盒子不等於同一個度量**：
      // 它讀 content box 的 computed `width`（小數、`parseInt` 捨去），我們讀 padding box 的
      // `clientWidth`（四捨五入成整數）。目前一致是因為 host 沒有 padding —— 日後若加上
      // padding，這條等式就要重新檢查。
      const host = term.element?.parentElement
      if (!host || host.clientWidth === 0 || host.clientHeight === 0) return null

      const proposed = fitAddon.proposeDimensions()
      if (!proposed) return null
      if (!Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null
      if (proposed.cols < 1 || proposed.rows < 1) return null

      fitAddon.fit()
      if (term.cols === lastCols && term.rows === lastRows) return null

      lastCols = term.cols
      lastRows = term.rows
      return { cols: term.cols, rows: term.rows }
    },
    size() {
      return { cols: term.cols, rows: term.rows }
    },
    write(data) {
      term.write(data)
    },
    serialize() {
      return serializeAddon.serialize({ scrollback: SNAPSHOT_LINES })
    },
    replay(history, separator, done) {
      term.write(history, () => {
        // **快照裡可能含 `?1049h`**（實測：`SerializeAddon` 會把終端模式一起序列化）——
        // 使用者關掉 app 時若正開著 vim，重播到這裡我們就**站在 alternate buffer 裡**。
        // 不離開它，新的 shell 就跑在 vim 的畫面上：歷史全部看不見、沒有 scrollback。
        //
        // **`?1049l` 只在確實處於 alt buffer 時才送。** 它會還原「進入 alt screen 當下所儲存的
        // 游標」—— 真的進去過時，那正是我們要的位置；**沒進去過時，那個位置是 (0,0)**，游標會被
        // 拉回左上角，接著寫入的分隔線就蓋掉歷史的第二行、live 的第一個 prompt 再蓋掉第三行。
        const leaveAlt = term.buffer.active.type === 'alternate' ? '\x1b[?1049l' : ''

        term.write(`${leaveAlt}${RESET_MODES}`, () => {
          const buffer = term.buffer.active

          // 內容的最後一個非空行（絕對座標）。
          let last = buffer.length - 1
          while (last > 0 && (buffer.getLine(last)?.translateToString(true).trim() ?? '') === '') {
            last -= 1
          }

          // 游標若停在內容之上，往下挪到內容之後。**只用相對移動** —— `\n` 會正確捲動，而絕對
          // 定位在一個「尺寸與快照當下不同」的終端上會落在錯的地方。
          const cursor = buffer.baseY + buffer.cursorY
          const down = Math.max(0, last - cursor)
          term.write(`${'\n'.repeat(down + 1)}\r${separator}`, done)
        })
      })
    },
    onInput(listener) {
      const disposable = term.onData(listener)
      return () => disposable.dispose()
    },
    onTitle(listener) {
      const disposable = term.onTitleChange(listener)
      return () => disposable.dispose()
    },
    getSelection() {
      return term.getSelection()
    },
    hasSelection() {
      return term.hasSelection()
    },
    paste(text) {
      // 原封不動送交 pty。xterm 會處理 bracketed paste（程式若啟用了它，shell 就知道
      // 這是「貼上」而非逐鍵輸入）。
      term.paste(text)
    },
    setFont(font) {
      fontOverride.family = font.family
      fontOverride.size = font.size
      fontOverride.lineHeight = font.lineHeight

      const family = resolveFamily()
      const size = resolveSize()
      const lineHeight = resolveLineHeight()

      let changed = false
      if (term.options.fontFamily !== family) {
        term.options.fontFamily = family
        changed = true
      }
      if (term.options.fontSize !== size) {
        term.options.fontSize = size
        changed = true
      }
      if (term.options.lineHeight !== lineHeight) {
        term.options.lineHeight = lineHeight
        changed = true
      }
      return changed
    },
    setGpuRenderer(enabled) {
      if (enabled === (webgl !== null)) return webgl !== null

      if (!enabled) {
        // dispose 之後 xterm 自動退回 DOM renderer —— buffer 不動，scrollback 不受影響。
        webgl?.dispose()
        webgl = null
        releaseWebglContext()
        return false
      }

      try {
        const addon = new WebglAddon()
        // 驅動重置或分頁背景化造成的 context loss —— 退回 DOM renderer，內容不遺失。
        //
        // **注意它擋不住「超出並存上限」**（那時最舊的 context 被靜默丟棄、不觸發此事件）——
        // 那由「只給 active 終端」承擔，見介面上的說明。
        //
        // 這裡**不**呼叫 `loseContext()`：脈絡已經失效，再 lose 一次沒有意義。
        addon.onContextLoss(() => {
          addon.dispose()
          webgl = null
          webglContext = null
        })
        const before = screenCanvases()
        term.loadAddon(addon)
        webglContext = captureWebglContext(before)
        webgl = addon
        return true
      } catch (error) {
        // 取不到 context —— 退回 DOM renderer 就好，這不是錯誤路徑（headless、軟體渲染、
        // 舊驅動都會走到這裡）。
        console.warn('[terminal] GPU renderer unavailable, falling back to DOM renderer', error)
        webgl = null
        webglContext = null
        return false
      }
    },
    focus() {
      term.focus()
    },
    dispose() {
      webgl?.dispose()
      releaseWebglContext()
      serializeAddon.dispose()
      fitAddon.dispose()
      term.dispose()
    },
  }
}
