import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { isWaitingForUser } from '@shared/intake/scheduled'

import type { IntakeSnapshot } from '../../../../main/ipc/intake'

/**
 * 收件匣的狀態 —— **常駐**，而不是隨 overlay 掛載。
 *
 * ## 為什麼要常駐
 *
 * 兩個理由，第二個是承重的：
 *
 * 1. 活動列上的計數要在收件匣沒被打開時也正確。
 * 2. **主行程的收件者集合是在 renderer 第一次呼叫 `list()` 時才註冊的**
 *    （`ipc/intake.ts` 的 `senders.add(event.sender)` 住在 `list` handler 裡）。在這個 provider
 *    出現之前，`list()` 只有 overlay 掛載時才會被呼叫 —— 也就是**一個從來沒有被打開過的
 *    收件匣，其變化不會推給任何人**。
 *
 * ## 一次求值
 *
 * 「送到畫面上的那個數字」與「畫面上列出來的那些項目」出自**同一份快照**。各自判斷什麼算
 * 「待處理」的話，兩份定義可以無聲地分岔，而症狀是「標示說三件、打開只有兩件」——
 * 沒有任何一邊會失敗。
 */

export interface IntakeState {
  snapshot: IntakeSnapshot
  /** 待處理的則數。**routing 解析不出來的仍計入**（它仍然是一件待處理的事）。A scheduled handoff is not counted until it opens. */
  pendingCount: number
  /** 顯式重新拉取。主行程那幾條路徑都有推送，但保留它是第二條防線。 */
  refresh: () => void
}

const EMPTY: IntakeSnapshot = { items: [], notices: [] }

const IntakeContext = createContext<IntakeState>({
  snapshot: EMPTY,
  pendingCount: 0,
  refresh: () => {},
})

export function IntakeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<IntakeSnapshot>(EMPTY)

  // **`[]` 依賴是承重的**：不穩定的 identity 會讓下面那個 effect 每次渲染都重訂閱 ＋ 重 `list()`，
  // 而 `list()` 會 `setState` ⇒ 無限迴圈。而 `exhaustive-deps` 會**主動要求**把它加進依賴。
  const refresh = useCallback(() => {
    void window.workspace.intake
      .list()
      .then(setSnapshot)
      .catch(() => setSnapshot(EMPTY))
  }, [])

  useEffect(() => {
    // **先訂閱、再列清單。** 兩者之間的窗口裡發生的變動會兩頭落空：清單沒看到它，
    // 推送也還沒開始收（`useWorkspaceFolders` 的檔頭記過同一條）。
    const unsubscribe = window.workspace.intake.onChanged(refresh)
    refresh()
    return unsubscribe
  }, [refresh])

  const value = useMemo<IntakeState>(
    () => ({
      snapshot,
      pendingCount: snapshot.items.filter(isWaitingForUser).length,
      refresh,
    }),
    [snapshot, refresh],
  )

  return <IntakeContext.Provider value={value}>{children}</IntakeContext.Provider>
}

export function useIntake(): IntakeState {
  return useContext(IntakeContext)
}
