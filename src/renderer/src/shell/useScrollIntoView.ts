import { useEffect, useMemo, useRef } from 'react'

/**
 * 兩種軸向各自的 `ScrollIntoViewOptions`，**定義在模組層級**。
 *
 * 它們曾經是呼叫端寫在參數位置的 inline object literal —— 每次渲染都是新身分。一旦這樣的值
 * 成為 hook 的參數，effect 讀得到它，`react-hooks/exhaustive-deps` 就會（正確地）要求把它加進
 * 依賴陣列，而那正是本 hook 存在的理由所要防的東西。**軸向因此以字面量聯集表達：它沒有身分
 * 可言。**
 */
const OPTIONS: Record<ScrollAxis, ScrollIntoViewOptions> = {
  block: { block: 'nearest' },
  both: { block: 'nearest', inline: 'nearest' },
}

/** `block` ＝ 只捲縱向（rail）；`both` ＝ 縱橫都捲（分頁列是 `overflow-x`）。 */
export type ScrollAxis = 'block' | 'both'

/**
 * 目標的位置改變時把它捲進可視範圍 —— **但使用者以指標直接操作這個容器時不捲**。
 *
 * ## 觸發條件是 `key`，而 `key` 只能是純量
 *
 * `keyboard-navigation` 的要求是「**選取、焦點或順序改變時**捲動」，而**這個 hook 的 `key` 就是
 * 那句話在程式碼裡唯一的載體**。它曾經是呼叫端自己寫的 effect，依賴陣列裡放著每次渲染都重建的
 * session 陣列 —— 於是實際的觸發條件變成「這個元件重繪了」，而背景中運作的 agent 每改一次終端
 * 標題就重繪一次：使用者手動捲到的位置被持續搶回 focused session 那一列。
 *
 * `key` 的型別是純量，**「把整個集合當成觸發條件」在這個介面上寫不出來**：呼叫端得先自己把它壓
 * 成一個值（身分 ＋ 位置），而那個動作本身就是在回答「這條 requirement 的觸發條件是什麼」。
 * `null` ＝ 當下沒有目標。
 *
 * 這個介面擋的是「不小心」，不是「刻意」—— 呼叫端仍可以組出一個每次渲染都不同的 key（驗收的
 * 對照組正是這樣做的）。沒有介面擋得住刻意；能擋掉「順手把手上的陣列丟進去」已經是這個缺陷的
 * 全部成因。
 *
 * ## 判定是「最後一次輸入來自哪裡」，不是「消費一次旗標」
 *
 * 直覺的寫法是「mousedown 設旗標、effect 讀完即清」。**它會靜默吃掉一次鍵盤導航**：一次
 * 沒有造成任何狀態改變的點擊（點已經選中的那一列、點捲軸、點空白處）不會觸發 effect，旗標
 * 於是留到下一次 —— 而下一次可能是 `Ctrl+↓`，使用者會看到「第一次沒捲、第二次才捲」。
 * 這裡改為記錄**最後一次輸入的來源**：任何一顆按鍵都會把它翻回鍵盤，旗標不會過夜。
 *
 * `block: 'nearest'` 只保證「**完全**可見就不捲」：部分可見的元素它照樣會捲最小的量。於是
 * rail 已捲動時點下緣那半截的列，那一列會在游標底下跳走 —— 使用者下一次點擊（例如緊鄰的
 * 展開鈕）得重新瞄準。**看不到目標是一種故障，目標在游標底下跳走是另一種**，這個例外要的是
 * 後者。
 *
 * ## 作用域是單一容器，不是整個 renderer
 *
 * 全域的「最後一次輸入」會壞掉一個真實的路徑：在 rail 點一列 session 之後，**分頁列仍應**
 * 把對應的分頁捲進視野 —— 使用者操作的是另一個容器，那個分頁他還沒看到。因此每個會自行
 * 捲動的容器各持有一份，回傳的 guard 掛在誰身上，例外就只對誰成立。
 *
 * @param key 觸發條件。**必須同時涵蓋目標的身分與它的位置** —— 少了位置，`Shift+↑↓` 這類
 *   「選取與焦點都沒變、只有順序變了」的導航會靜默地不捲。
 * @param resolve 取得目標元素。它是一個 closure，每次渲染都是新身分，因此**不進依賴**：
 *   由 latest-ref 吞掉，effect 執行時讀到的一定是最新的那一份。
 * @returns 掛在容器根節點上的 props。**捕捉階段** —— 子節點自己 `stopPropagation()` 也擋不掉
 *   它（session 子列與分頁都有自己的按鈕與右鍵選單）。**用 `mousedown` 而不是 `pointerdown`**：
 *   與 `useDragReorder` 一致（這個 repo 為了「探針送得進真事件」刻意選了滑鼠事件而非 HTML5
 *   拖放），於是這個例外驗得到 —— CDP 的 `Input.dispatchMouseEvent` 一定產生 `mousedown`。
 */
export function useScrollIntoView(
  key: string | null,
  resolve: () => Element | null | undefined,
  axis: ScrollAxis,
  /**
   * Scroll after the other targets of the same commit. A child's effects run before its parent's, so in a container
   * with two targets — the rail's item row (parent) and its focused session row (child) — the parent's would win
   * when both cannot be shown, and the session the user went to would be scrolled out again
   * (`session-wait-indicator`: the rail shows the row of the session the summary went to).
   */
  { last = false }: { last?: boolean } = {},
): { onMouseDownCapture: () => void } {
  const byPointer = useRef(false)

  useEffect(() => {
    const onKeyDown = (): void => {
      byPointer.current = false
    }
    /*
      **A `mousedown` outside this container clears it too** (`session-wait-indicator`, "The rail scrolls to the
      target even after a click on the rail"). With only keys clearing it, a click on the rail followed by a click
      on the header's summary left the rail unscrolled: the last input *in the rail* was the pointer, but the
      user's last input was elsewhere. The exception is "the last input was a `mousedown` inside this container".
    */
    const onMouseDown = (): void => {
      byPointer.current = false
    }
    // 捕捉階段：`KeyboardNavigation` 攔下導航鍵時呼叫的是 `stopPropagation()`，它擋不住
    // **同一個節點**上的其他 listener（那要 `stopImmediatePropagation`），所以這裡收得到。
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('mousedown', onMouseDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [])

  /**
   * **ref 於 effect 內更新，不在渲染期間指派** —— 後者是 React 的違規動作，`react-hooks/refs`
   * 對它是 error（這個 repo 已經為「渲染期間寫 ref」付過一次學費，見 `WorkspaceRail` 裡
   * `commitFolderOrder` 上方那段註解）。這個 effect 沒有依賴陣列：它每次渲染後都跑，而它要做的
   * 就是這件事。
   */
  const resolveRef = useRef(resolve)
  useEffect(() => {
    resolveRef.current = resolve
  })

  /**
   * 上一次的 `key`。**sentinel 是 `undefined`，不能用 `null`** —— `null` 是「當下沒有目標」這個
   * **合法的 key 值**，兩者混用會讓「從無目標變成有目標」被當成首次而漏捲。
   */
  const lastKey = useRef<string | null | undefined>(undefined)

  /**
   * 捲動**於 DOM 反映新狀態之後**執行 —— 順序改變後元素的位置隨之改變，於同一輪更新中量測會
   * 得到舊位置。effect 保證了這件事，而副作用收在這裡也讓呼叫端**無從**把它寫進 state 的
   * updater（StrictMode 會 double-invoke updater，這個 repo 為此付過一次「拖曳完全沒反應、
   * 且只有 dev 模式壞」的學費）。
   *
   * **首次執行不捲** —— 掛載不是「選取、焦點或順序改變」。這不是防禦性的保險，它是 requirement
   * 的字面推論，而且**實測是承重的**：rail 的 `<ul>` 裡有兩個捲動來源（選中項目的標題列、
   * focused session 的子列），`Shift+↑↓` 移動選中的 folder 時，重排會讓子列那一份重新掛載 ——
   * 於是它在標題列剛被捲進視野之後**又捲了一次**，把畫面帶到別的地方（實測 dev：298 → 106 →
   * 238，最後停在目標看不見的位置；build 無 StrictMode 而未重現）。兩個來源搶同一個容器時，
   * 「掛載也算一次改變」就是那個讓後手贏的漏洞。
   */
  useEffect(() => {
    const previous = lastKey.current
    lastKey.current = key
    if (previous === undefined || key === null || key === previous) return
    if (byPointer.current) return
    // A commit's passive effects run in one synchronous pass; a microtask runs after all of them.
    if (last) queueMicrotask(() => resolveRef.current()?.scrollIntoView(OPTIONS[axis]))
    else resolveRef.current()?.scrollIntoView(OPTIONS[axis])
  }, [key, axis, last])

  /*
    The container's capture handler runs **after** the window's capture listener for the same event (capture goes
    from the window down), so a `mousedown` anywhere clears the flag and one inside this container sets it again.
  */
  return useMemo(
    () => ({
      onMouseDownCapture: (): void => {
        byPointer.current = true
      },
    }),
    [],
  )
}
