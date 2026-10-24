import { useEffect } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { ActivityBar } from './ActivityBar'
import { KeyboardNavigation } from './KeyboardNavigation'
import { MainStage } from './MainStage'
import { PreferencesProvider } from './PreferencesProvider'
import { StatusBar } from './StatusBar'
import { WorkspaceRail } from './WorkspaceRail'
import { DirtyBuffersProvider } from './files/dirty-buffers'
import { OpenSpecProvider } from './openspec/data'
import { PanelCoordinateProvider } from './panel-coordinate'
import { SessionsProvider } from './terminal/sessions'
import { LineageProvider } from './terminal/lineage'
import { HandoffBriefProvider } from './terminal/HandoffBrief'
import { LifecycleProvider } from './terminal/lifecycle'
import { WaitProvider } from './terminal/wait'
import { IntakeProvider } from './intake/intake-state'
import { IntakeAutoAccept } from './intake/IntakeAutoAccept'
import { RemoteRequests } from './remote/RemoteRequests'
import { PrefillProvider } from './intake/prefill-state'
import { folderSelection } from './types'
import { useWorkspaceFolders } from './useWorkspaceFolders'

const SEPARATOR_CLASS = 'w-[3px] cursor-col-resize bg-hairline transition-colors hover:bg-accent'

export function AppShell(): React.JSX.Element {
  const { folders, selection, select, addFolder, removeFolder, reorderFolders, setPinned } =
    useWorkspaceFolders()
  // Tell the main process that the listeners outside actions talk to are mounted (`window-presence.ts`).
  // **A parent's effect runs after its children's**, so by now the inbox (`ActivityBar`), the handoff
  // brief (`HandoffBriefProvider`) and session focusing (`IntakeAutoAccept`) have subscribed.
  useEffect(() => {
    window.workspace.app.rendererReady()
  }, [])
  // Provider 在此 —— 未存的變更必須活過切換 folder（FilesPanel 以 folder.id 為 key 掛載）。
  // SessionsProvider 同理，且要同時涵蓋 rail 與主舞台：rail 呈現所有 folder 的 session，
  // 主舞台掛載它們的終端（design D9）。
  //
  // OpenSpecProvider 必須在 MainStage 之上：MainStage 要知道當前 folder 的 active change
  // 才能決定新 session 的錨定（`openspec-side-panel` 的 design D3）。
  return (
    <PreferencesProvider>
      <DirtyBuffersProvider folders={folders}>
        <SessionsProvider>
          <PrefillProvider>
          {/*
            收件匣的狀態是**常駐**的 —— 活動列的計數要在收件匣沒被打開時也正確，而且主行程的
            收件者集合是在第一次 `list()` 時才註冊的（見 `intake-state.tsx` 的檔頭）。
            必須在 `SessionsProvider` 之內：overlay 用 `useSessions()`。
          */}
          <IntakeProvider>
          {/*
            側欄座標的 Provider 與 SessionsProvider 同一層 —— 它有兩個消費者（MainStage 與
            StatusBar），兩者都在這一層之下。座標隸屬於 rail 的項目而非 session，但它與 session
            一樣必須活過「切換 folder」，因此掛在同一個高度。
          */}
          {/*
            交接關係的呈現（跳轉、「存在」的判定）—— rail 與分頁列都用它，而跳到另一個 rail 項目
            的 session 需要改變選中的項目，那是這一層才有的能力。必須在 `SessionsProvider` 之內。
          */}
          <LineageProvider
            folders={folders}
            onSelectItem={(folderId) =>
              folderId === null ? select({ kind: 'global' }) : select(folderSelection(folderId))
            }
          >
          {/* 交接單（`handoff-brief`）—— 入口在 rail 與分頁列兩處，它要 `useLineage()`，所以在它之內。 */}
          <HandoffBriefProvider>
          {/* 生命週期（`handoff-completion`）—— 狀態標記與「收掉已完成」。要 `useLineage()`。 */}
          <LifecycleProvider>
          {/* Every running agent session's attention (`session-wait-indicator`) — the rail's and the tabs' dots. */}
          <WaitProvider>
          <PanelCoordinateProvider>
          <OpenSpecProvider>
            {/*
              必須在 `SessionsProvider` 之內（它要 `useSessions()`），而 `AppShell` 本身正是渲染
              那個 Provider 的元件 —— 掛在這一層才拿得到 context。它不渲染任何東西。
            */}
            {/*
              到達即接受，以及「通知把我帶到那個 session」。**常駐** —— 交接在使用者沒有打開
              收件匣的時候到達，而 overlay 只在被打開時掛載。
            */}
            <IntakeAutoAccept
              onReveal={(folderId) =>
                folderId === null ? select({ kind: 'global' }) : select(folderSelection(folderId))
              }
            />
            {/* A paired device's create, wake and accept — carried out quietly (`remote-protocol`). Resident. */}
            <RemoteRequests />

            <KeyboardNavigation
              folders={folders}
              selection={selection}
              onSelectGlobal={() => select({ kind: 'global' })}
              onSelectFolder={(id) => select(folderSelection(id))}
              onReorderFolder={(id, toIndex, pinned) => void reorderFolders(id, toIndex, pinned)}
            />

            {/*
              三欄 + 底部狀態列。狀態列**不隸屬於任何一欄** —— 它橫跨整個視窗，且不受 side panel
              收合或任一分界拖動影響（`workspace-layout` 的新 requirement）。因此三欄的 Group 要
              包進一個直向容器，並以 `min-h-0` 讓它把剩下的高度讓給狀態列。
            */}
            <div className="flex h-full w-full flex-col">
            {/*
              **活動列不是 `Panel`，它在 `Group` 之外。** react-resizable-panels 的
              `groupResizeBehavior` 預設為 `preserve-relative-size` —— px 尺寸於掛載時換算成容器
              百分比，此後視窗一放大每個 panel 就等比長大（受 `maxSize` 夾制而有上限，但 56px →
              120px 已是兩倍多）。而活動列是一列固定尺寸的圖示按鈕，**加寬不會多顯示任何東西**。
              移出 `Group` 之後，「它被拖動」與「它隨視窗長大」兩件事在結構上表達不出來。

              這一層橫向容器需要 `min-h-0 flex-1`，`Group` 需要 `min-w-0 flex-1` ——
              `ActivityBar` 的 `<nav>` 是 `h-full`，父層沒有確定高度時它會塌。
            */}
            <div className="flex min-h-0 w-full flex-1">
              <ActivityBar />

              <Group orientation="horizontal" className="min-w-0 flex-1">
              {/*
                `min-w-0` 不是裝飾：flex item 的 `min-width` 預設是 `auto`，於是 Panel 會被它的
                **內容**撐住，縮不到 `minSize` —— 宣告的最小寬度就兌現不了（spec 要求「拖動 SHALL
                被夾制於該下限」）。字級小的時候 rail 的 min-content 恰好小於 180px，這個缺陷因此
                一直看不出來；`--text-base` 一調到 17px，rail 就再也縮不到 180px（實測卡在 240px，
                是探針抓到的）。**最小寬度是版面契約，不該隨字級浮動** —— 所以修 Panel，不是調高 180。
              */}
              <Panel defaultSize="260px" minSize="180px" className="min-w-0">
                <WorkspaceRail
                  folders={folders}
                  selection={selection}
                  onSelect={(id) => select(folderSelection(id))}
                  onSelectGlobal={() => select({ kind: 'global' })}
                  onAdd={() => void addFolder()}
                  onRemove={(id) => void removeFolder(id)}
                  onReorder={(id, toIndex, pinned) => void reorderFolders(id, toIndex, pinned)}
                  onSetPinned={(id, pinned) => void setPinned(id, pinned)}
                />
              </Panel>

              <Separator className={SEPARATOR_CLASS} />

              {/*
                The main stage's minimum is what its own two columns need: the terminal's 240 px, the separator's 3
                and the side panel's 240. It was 360, below that sum, so a narrow window — or a 1280-px window at
                175% zoom, 731 CSS px wide (`ui-appearance`) — squeezed the columns past their minimums instead of
                narrowing the rail toward its own.
              */}
              <Panel minSize="483px">
                <MainStage selection={selection} folders={folders} />
              </Panel>
              </Group>
            </div>

            <StatusBar folders={folders} selection={selection} />
            </div>
          </OpenSpecProvider>
          </PanelCoordinateProvider>
          </WaitProvider>
          </LifecycleProvider>
          </HandoffBriefProvider>
          </LineageProvider>
          </IntakeProvider>
          </PrefillProvider>
        </SessionsProvider>
      </DirtyBuffersProvider>
    </PreferencesProvider>
  )
}
