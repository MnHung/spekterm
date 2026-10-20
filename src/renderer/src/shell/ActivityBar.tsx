import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InsightsOverlay } from './insights/InsightsOverlay'
import { IntakeOverlay, type IntakeTab } from './intake/IntakeOverlay'
import { useIntake } from './intake/intake-state'
import { SettingsDialog, type SettingsSection } from './settings/SettingsDialog'
import { useRemoteState } from './remote/useRemoteState'

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  className: 'h-5 w-5',
} as const

interface ActivityItem {
  id: string
  /** 文案在渲染時才自字典取出 —— 這是模組層級的常數，那時 `t` 尚未初始化。 */
  labelKey:
    | 'activityBar.sessions'
    | 'activityBar.handoffs'
    | 'activityBar.search'
    | 'insights.label'
    | 'activityBar.settings'
  enabled: boolean
  icon: React.JSX.Element
  atBottom?: boolean
}

/**
 * 雛型的四個入口全部保留位置，讓版面比例自第一天起就一致。
 * 尚未實作的入口停用並說明原因 —— 點了沒反應會被當成壞掉。
 */
const ITEMS: ActivityItem[] = [
  {
    id: 'sessions',
    labelKey: 'activityBar.sessions',
    enabled: true,
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="3" width="7" height="9" />
        <rect x="14" y="3" width="7" height="5" />
        <rect x="14" y="12" width="7" height="9" />
        <rect x="3" y="16" width="7" height="5" />
      </svg>
    ),
  },
  {
    id: 'handoffs',
    labelKey: 'activityBar.handoffs',
    // **由 `agent-intake-inbox` 啟用。** 雛型枚舉的入口集合本來就有 Handoffs，
    // 它此前為停用只因為背後的能力尚未存在 —— 接上它是兌現雛型，不是偏離它。
    enabled: true,
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
    ),
  },
  {
    id: 'search',
    labelKey: 'activityBar.search',
    enabled: false,
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3-3" />
      </svg>
    ),
  },
  {
    // **第五個入口，而雛型只畫了四個。** 這是對 `docs/workspace-mockup.html` 的一次明示偏離
    // （裁決見 `workspace-layout` 的 requirement）：對話計量的範圍是整個 workspace，
    // 不隸屬任何 folder、也不是側欄座標之下的東西 —— 活動列正是「不隸屬任何 repo 的全域入口」
    // 該在的位置。已排除的替代方案是塞進 Settings 對話框：**Settings 是放旋鈕的地方，
    // 而這是內容**，混在一起會讓 Settings 逐漸變成雜物間。
    id: 'insights',
    labelKey: 'insights.label',
    enabled: true,
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M3 3v18h18" />
        <path d="M7 15v2" />
        <path d="M11 11v6" />
        <path d="M15 7v10" />
        <path d="M19 13v4" />
      </svg>
    ),
  },
  {
    id: 'settings',
    labelKey: 'activityBar.settings',
    enabled: true,
    atBottom: true,
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
]

export function ActivityBar(): React.JSX.Element {
  const { t } = useTranslation()
  const { pendingCount } = useIntake()
  // Settings, open on a section or on the last one shown (`initialSection` undefined).
  const [settings, setSettings] = useState<{ section?: SettingsSection } | null>(null)
  // The section shown last in this run: Settings reopens there, and a new run starts on General
  // (`terminal-preferences`). Not stored.
  const [lastSection, setLastSection] = useState<SettingsSection>('general')
  const remote = useRemoteState()
  const remoteConnected = remote?.devices.some((device) => device.connected) ?? false
  // 開啟 overlay 的那個按鈕 —— 關閉時焦點要還給它，否則落回 `<body>`，下一次按鍵什麼都不發生。
  const [insightsOpener, setInsightsOpener] = useState<HTMLElement | null>(null)
  const [intakeOpener, setIntakeOpener] = useState<HTMLElement | null>(null)
  const [intakeTab, setIntakeTab] = useState<IntakeTab>('inbox')
  // Whether the inbox is open, for the notification listener registered once below (its closure would be stale).
  const intakeOpenRef = useRef(false)
  useEffect(() => {
    intakeOpenRef.current = intakeOpener !== null
  }, [intakeOpener])
  const handoffsRef = useRef<HTMLButtonElement>(null)

  /**
   * **穩定的 identity 是承重的。** 寫成 inline arrow 的話，這個元件每重繪一次，overlay 那邊
   * 以它為依賴的 effect 就重跑一次 —— 而這個元件現在訂閱了收件匣狀態。
   */
  const closeIntake = useCallback(() => setIntakeOpener(null), [])
  const closeInsights = useCallback(() => setInsightsOpener(null), [])

  /**
   * 使用者觸發了通知 ⇒ 打開收件匣。
   *
   * **已開啟時必須是無操作** —— 以純函式 updater 保證。寫成「先讀 state 再判斷」的話，
   * 這個註冊在 `[]` 依賴的 effect 裡讀到的是一個**永遠為 null 的 stale closure**；
   * 把 state 加進依賴又會讓每次開關都重訂閱，而重訂閱的空窗會吃掉一則訊息。
   */
  useEffect(() => {
    return window.workspace.intake.onOpenInbox((tab) => {
      // **Opening the inbox closes Settings, by any route** (`terminal-preferences`): a notification can arrive
      // while Settings is open, and two modal layers would then compete for focus and for Esc.
      setSettings(null)
      // The tab is set on every opening by a notification — an inbox last left on rules would otherwise reopen there
      // — and left alone when the inbox is open (`agent-intake`: the trigger is then a no-op).
      if (!intakeOpenRef.current) setIntakeTab(tab)
      setIntakeOpener((current) => current ?? handoffsRef.current)
    })
  }, [])

  // Sessions 恆為當前 view；**Search 仍是停用的 placeholder**
  //（`workspace-layout`：尚未實作的入口為停用狀態）。Handoffs 已由 `agent-intake-inbox` 接上。
  // The entry the user is in: Sessions is the base view; Settings, the inbox and the metrics are while
  // they are open. Marking every enabled entry left no way to tell where one is.
  const isCurrent = (id: string): boolean =>
    id === 'sessions' ||
    (id === 'settings' && settings !== null) ||
    (id === 'handoffs' && intakeOpener !== null) ||
    (id === 'insights' && insightsOpener !== null)

  const activate = (id: string, element: HTMLElement): void => {
    if (id === 'settings') setSettings({})
    if (id === 'insights') {
      setSettings(null)
      setInsightsOpener(element)
    }
    if (id === 'handoffs') {
      setSettings(null)
      setIntakeTab('inbox')
      setIntakeOpener(element)
    }
  }

  return (
    <nav
      aria-label={t('activityBar.label')}
      // 寬度是**版面契約**，不是一個可調整的值：52px 恰為按鈕的 `w-9`(36px) 加上 `px-2`(2×8px)。
      // `shrink-0` 讓它不參與收縮 —— 它是這一列唯一固定寬度的區域（`workspace-layout`）。
      className="flex h-full w-[52px] shrink-0 flex-col items-center gap-1 border-r border-hairline bg-shell px-2 py-3"
    >
      {ITEMS.map((item) => {
        const label = t(item.labelKey)

        return (
          <div key={item.id} className={item.atBottom ? 'mt-auto flex flex-col gap-1' : undefined}>
            {/*
              While a paired device is connected (`remote-access`): who can type into the sessions must be
              visible. Shown only then, and **above** Settings inside the bottom group, so appearing or
              disappearing never moves the Settings entry from under the pointer.
            */}
            {item.atBottom && remoteConnected ? (
              <button
                type="button"
                aria-label={t('remote.indicator')}
                title={t('remote.indicator')}
                onClick={() => setSettings({ section: 'remote' })}
                className="flex h-9 w-9 items-center justify-center rounded-md text-accent"
              >
                <svg {...ICON_PROPS}>
                  <rect x="7" y="2" width="10" height="20" rx="2" />
                  <path d="M11 18h2" />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              ref={item.id === 'handoffs' ? handoffsRef : undefined}
              disabled={!item.enabled}
              // `aria-label` 同時是探針的選擇器（自字典取字串，不硬編）—— 見「aria-label 是選擇器」。
              aria-label={label}
              aria-current={item.enabled && isCurrent(item.id) ? 'page' : undefined}
              onClick={item.enabled ? (event) => activate(item.id, event.currentTarget) : undefined}
              title={item.enabled ? label : t('activityBar.comingSoon', { label })}
              className={
                'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ' +
                (!item.enabled
                  ? 'text-ink-faint opacity-40 hover:bg-transparent'
                  : isCurrent(item.id)
                    ? 'bg-accent/10 text-accent'
                    : 'cursor-pointer text-ink-dim hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent')
              }
            >
              {item.icon}
              {item.id === 'handoffs' ? <CountBadge total={pendingCount} /> : null}
            </button>
          </div>
        )
      })}


      {settings && (
        <SettingsDialog
          initialSection={settings.section ?? lastSection}
          onSectionShown={setLastSection}
          onClose={() => setSettings(null)}
          onOpenRoutingRules={() => {
            setSettings(null)
            setIntakeTab('rules')
            setIntakeOpener(handoffsRef.current)
          }}
        />
      )}
      {insightsOpener && <InsightsOverlay opener={insightsOpener} onClose={closeInsights} />}
      {intakeOpener && (
        <IntakeOverlay
          opener={intakeOpener}
          initialTab={intakeTab}
          onClose={closeIntake}
          onOpenSlackSettings={() => {
            // **The inbox closes first** (`terminal-preferences`): it sits above Settings and would keep the focus.
            closeIntake()
            setSettings({ section: 'integrations' })
          }}
        />
      )}
    </nav>
  )
}

/**
 * 入口上的計數標示。
 *
 * **三件事是承重的：**
 *
 * 1. **入口按鈕自己的無障礙標籤一個字都不改。** 在本 repo 中那個標籤同時是驗收定位元素的
 *    手段，併進計數會讓既有指名該入口的每一條斷言**選不到元素** —— 徵狀是求值得空值，
 *    不是斷言失敗。
 * 2. **它是 `<span>` 不是 `<button>`。** 活動列的入口是以 `nav … button` 列舉出來驗收的，
 *    多一顆按鈕會讓那份列舉從「入口」變成「入口＋裝飾」。
 * 3. **它需要自己的 role 才會被朗讀。** `role="button"` 的後代在無障礙樹中是呈現性的，
 *    而入口帶著顯式的標籤 ⇒ 巢狀元素上的標籤不會被讀出來。「分成兩個元素就同時滿足
 *    無障礙」是錯的。
 *
 * 絕對定位（父層按鈕帶 `relative`，無 offset 的 `relative` 不改變版面）——
 * 活動列是固定寬度的版面契約，標示不得改變入口的尺寸。字級只能用尺度的地板 `text-2xs`
 * （arbitrary 的字級會被 `typography.test.mjs` 擋下 —— **而那道守衛是行掃描，連註解一起吃**，
 * 所以這一段不能把那個字面形式寫出來），並明寫 `leading-none` 釘住行框。
 */
function CountBadge({ total }: { total: number }): React.JSX.Element | null {
  const { t } = useTranslation()
  // **為零時不渲染** —— 一個恆常存在的標示不構成提示。
  if (total <= 0) return null
  return (
    <span
      role="status"
      aria-label={t('intake.badge', { total })}
      className="pointer-events-none absolute -right-0.5 -top-0.5 min-w-[1.05rem] rounded-full bg-accent px-1 text-center text-2xs leading-none text-shell"
    >
      {total > 99 ? '99+' : total}
    </span>
  )
}
