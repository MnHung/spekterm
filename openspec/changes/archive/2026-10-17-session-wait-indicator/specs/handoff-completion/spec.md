## MODIFIED Requirements

### Requirement: 交接 session 的狀態由完成報告與等待狀態推導，且完成之後可重新開始

由交接建立的 session SHALL 依下列規則呈現狀態：

- **已完成**：已採納完成報告，且其後未重新開始；
- **進行中**：沒有完成報告、或已重新開始，且等待狀態為忙碌；
- **等你**：沒有完成報告、或已重新開始，且等待狀態為等待選擇，或等待狀態為就緒且其最近一次的一輪結束尚未被
  看過（`session-wait-indicator` 的看過標記）；
- **不呈現狀態**：沒有完成報告、或已重新開始，且等待狀態為未知（含休眠與已結束的 session ——
  它們照舊呈現既有的休眠或結束狀態），或等待狀態為就緒且已被看過。

The "waiting" state follows the seen mark so that "Waiting for you" means one thing across the application: the
session's status dot (`session-wait-indicator`) and this state say it at the same moments, and both stop saying it
once the user has looked at the session. Without that, a child the user has already read would keep a "Waiting for
you" mark beside an idle dot.

**完成的落定 SHALL 依「報告被採納之後」某一次等待狀態結算的值為就緒，SHALL NOT 依「狀態轉變為
就緒」。** 報告與等待狀態經兩條互不排序的通道抵達；agent 停下之後報告才被採納時，狀態不會再
「轉變為」就緒 —— 依轉變判定的話，它永遠不會落定。落定與重新開始依等待狀態本身判定，SHALL NOT 受看過標記影響。

**重新開始 SHALL 只在落定之後，某一次等待狀態結算的值為忙碌或等待選擇時發生。** agent 寫完報告
通常還會做事（例如把結果以訊息送給母 session），若報告之後的第一次忙碌即算重新開始，每一份報告都會
被它自己的收尾推翻。

等待狀態為**未知** SHALL NOT 觸發落定或重新開始。

重新開始 SHALL NOT 刪除先前的結果 —— 它仍可於交接單中取得，直到被下一份報告取代。

「已完成」「已落定」「已重新開始」SHALL 跨應用程式重啟保留。系統 SHALL NOT 因任何狀態自動結束
session 的 pty。

#### Scenario: 報告之後的收尾不推翻完成

- **WHEN** C 投遞完成報告，隨後等待狀態成為忙碌、再成為就緒
- **THEN** C 的狀態為已完成

#### Scenario: 報告於 agent 已停下之後才被採納

- **GIVEN** C 的等待狀態已為就緒
- **WHEN** C 先前寫下的完成報告此時才被採納，其後 C 的等待狀態成為忙碌
- **THEN** C 的狀態為進行中

#### Scenario: 完成之後再被交辦即重新開始

- **GIVEN** C 已完成，且報告被採納之後等待狀態已結算為就緒
- **WHEN** C 的等待狀態成為忙碌
- **THEN** C 的狀態為進行中
- **AND** C 的交接單仍呈現先前的結果

#### Scenario: 等待狀態落回未知不重新開始

- **GIVEN** C 已完成，且報告之後等待狀態已結算為就緒
- **WHEN** C 的等待狀態落回未知
- **THEN** C 的狀態仍為已完成

#### Scenario: 沒有報告時依等待狀態呈現

- **WHEN** C 尚未投遞任何報告，且等待狀態為就緒，且其一輪結束尚未被看過
- **THEN** C 的狀態為等你

#### Scenario: Looking at a child without a report clears its waiting state

- **WHEN** C has not delivered a report, its turn ended unseen so its state is waiting, and the user makes C the
  displayed session in the focused window
- **THEN** C presents none of working, waiting or done, and C's parent lists C with no state

#### Scenario: 等待狀態未知且沒有報告時不呈現狀態

- **WHEN** C 尚未投遞任何報告，且等待狀態為未知
- **THEN** C 不呈現進行中、等你或已完成任一者

#### Scenario: 已完成跨重啟保留

- **GIVEN** C 已完成
- **WHEN** 應用程式重新啟動
- **THEN** C 的狀態仍為已完成

#### Scenario: 完成不結束 pty

- **WHEN** C 成為已完成
- **THEN** C 的 pty 仍然存在
