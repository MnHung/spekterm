import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { validateName } from './names'
import { useTranslation } from 'react-i18next'

const OVERLAY_CLASS =
  'absolute inset-0 z-20 flex items-center justify-center bg-scrim px-4 text-sm'
const CARD_CLASS = 'w-full rounded border border-hairline bg-panel p-3 shadow-lg'
const BUTTON_CLASS = 'rounded border border-hairline px-2 py-[3px] text-xs hover:bg-stage'

interface NameDialogProps {
  title: string
  /** 改名時帶入原名；新增時為空。 */
  initialValue?: string
  /** 主行程回報的失敗（例如 ALREADY_EXISTS）。介面驗證不足以預知它。 */
  serverError: string | null
  onSubmit: (name: string) => void
  onCancel: () => void
}

/** 新增與改名共用。名稱在送出之前就先驗一次，讓使用者不必等一趟 IPC 才知道不合法。 */
export function NameDialog({
  title,
  initialValue = '',
  serverError,
  onSubmit,
  onCancel,
}: NameDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue)
  const [touched, setTouched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const localError = touched ? validateName(value) : null
  const error = localError ?? serverError

  const submit = (): void => {
    setTouched(true)
    if (validateName(value)) return
    onSubmit(value)
  }

  return (
    <div className={OVERLAY_CLASS}>
      {/*
        `role="dialog"` 不只是無障礙標記 —— 導航快捷鍵以 `[role="dialog"]` 的存在判定「有對話框
        開著」而整體不生效（session-navigation-and-labels 的 design D5）。少了它，使用者在這裡
        打字命名時，一個 Ctrl+Tab 就會把畫面切走。
      */}
      <div role="dialog" aria-label={title} className={CARD_CLASS}>
        <p className="text-ink">{title}</p>
        <input
          ref={inputRef}
          value={value}
          aria-label={title}
          onChange={(event) => {
            setValue(event.target.value)
            setTouched(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') onCancel()
          }}
          className="mt-2 w-full rounded border border-hairline bg-stage px-2 py-1 font-mono text-sm text-ink outline-none focus:border-accent"
        />
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={`${BUTTON_CLASS} text-ink-faint`}>
            {t('common.cancel')}
          </button>
          <button type="button" onClick={submit} className={`${BUTTON_CLASS} text-accent`}>
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

interface ConfirmDeleteProps {
  relPath: string
  isDirectory: boolean
  /** 這個檔案（或這個目錄之下）有未存的變更，刪除會一併丟棄。 */
  hasUnsaved: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 刪除的唯一閘門。
 *
 * 沒有復原，因此這是一個明確的確認，而不是一個可以略過的 toast。目錄一律遞迴刪除，
 * 訊息必須說出這件事。
 */
export function ConfirmDelete({
  relPath,
  isDirectory,
  hasUnsaved,
  onConfirm,
  onCancel,
}: ConfirmDeleteProps): React.JSX.Element {
  const { t } = useTranslation()
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => confirmRef.current?.focus(), [])

  return (
    <div className={OVERLAY_CLASS}>
      {/* `role="dialog"` 同時是導航快捷鍵的抑制依據 —— 見 NameDialog 的註解。 */}
      <div role="dialog" aria-label={t('files.deleteAria', { path: relPath })} className={CARD_CLASS}>
        <p className="text-ink">{t('files.deleteQuestion', { path: relPath })}</p>
        {isDirectory && (
          <p className="mt-1 text-xs text-ink-faint">{t('files.deleteDirectory')}</p>
        )}
        {hasUnsaved && <p className="mt-1 text-xs text-danger">{t('files.deleteUnsaved')}</p>}
        <p className="mt-1 text-xs text-ink-faint">{t('files.deleteIrreversible')}</p>

        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={`${BUTTON_CLASS} text-ink-faint`}>
            {t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onCancel()
            }}
            className={`${BUTTON_CLASS} text-danger`}
          >
            {t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}

export interface MenuItem {
  label: string
  onSelect: () => void
  tone?: 'danger'
  /** 停用而非隱藏 —— 使用者要看得到這個操作存在，只是此刻不可用（例如沒有選取內容時的複製）。 */
  disabled?: boolean
  /**
   * 次要說明，置於標籤下方。
   *
   * **停用的項目尤其需要它** —— 一個沒有原因的停用項只會讓人以為壞了。這正是「呈現但停用」
   * 相對於「整筆省略」的價值所在：省略讓使用者無從分辨那是刻意的限制還是應用程式沒看見它。
   */
  hint?: string
  /** React key。標籤可能重複時給它（例如兩個 detached 於同一 commit 的工作目錄）。 */
  key?: string
}

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** 選單邊緣與 viewport 之間的留白，避免緊貼邊界。 */
const MENU_MARGIN = 8

/** 樹上的操作入口。mockup 對此沉默，形式由本 change 定義（design D16）。 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // 掛載後量自己的尺寸，把位置夾進 viewport —— 否則貼著右／下緣的觸發點（例如 header 的
  // 「＋」在右上角）會讓選單溢出畫面外看不到。useLayoutEffect 在繪製前調整，不會閃一下。
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(MENU_MARGIN, Math.min(x, window.innerWidth - rect.width - MENU_MARGIN))
    const top = Math.max(MENU_MARGIN, Math.min(y, window.innerHeight - rect.height - MENU_MARGIN))
    setPos({ left, top })
  }, [x, y])

  useEffect(() => {
    const dismiss = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    /**
     * **在 window 的 capture 階段收掉任何落在選單之外的按下 —— 這是「同時只有一個選單」的載體。**
     *
     * bubble 階段的 `click`／`contextmenu` 不夠：終端把右鍵整顆攔在自己 host 的 capture 階段
     * （`TerminalView`，為了不把它轉發給 pty），那次事件**冒不到 window** —— 於是「在終端右鍵」
     * 關不掉分頁上已經開著的那一個，兩個選單並存。**capture 由 window 往下傳，早於 host 的攔截**，
     * 因此這條路徑攔不掉。
     *
     * 落在自己身上的按下要放行：否則按在選單項目上時，這裡會先把選單卸載，那次 `click` 就沒有
     * 對象可以觸發了。
     */
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      onClose()
    }
    // **延一個 tick 才掛。** 開啟這個選單的那一次 click／contextmenu／mousedown 會傳到 window，
    // 若當下就掛上 dismiss，它會被自己開啟的事件立刻關掉 —— React 19 對 trusted 的
    // discrete 事件會同步 flush effect，因此 listener 會在同一次事件的傳遞途中就生效
    //（實測：右鍵完全開不起來，因為 contextmenu 未 stopPropagation 而冒泡到 window）。
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', onPointerDown, true)
      window.addEventListener('click', dismiss)
      window.addEventListener('contextmenu', dismiss)
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('click', dismiss)
      window.removeEventListener('contextmenu', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // **開啟時把焦點放到第一個可用的選項。**
  //
  // 這是「以 `Ctrl+T` 叫出選單」能成立的前提 —— 用快捷鍵叫出一個只能用滑鼠點的選單，等於沒做
  // 這個快捷鍵（design D9）。停用的項目跳過（`disabled` 的 `<button>` 本來就不可聚焦）。
  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      'button[role="menuitem"]:not([disabled])',
    )
    first?.focus()
  }, [])

  /** `↑/↓` 於選項間循環移動。`Enter`／`Space` 不必處理 —— `<button>` 原生就會觸發 onClick。 */
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    event.stopPropagation()

    const options = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not([disabled])',
      ) ?? []),
    ]
    if (options.length === 0) return

    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const next = (current + delta + options.length) % options.length
    options[next]?.focus()
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      onKeyDown={onMenuKeyDown}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-30 min-w-[150px] rounded border border-hairline bg-panel py-1 text-sm shadow-lg"
    >
      {items.map((item) => (
        <button
          key={item.key ?? item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          // **關閉由選單自己完成，不倚賴「這次點擊冒泡到 window 由下面那個 dismiss 順帶關掉」。**
          // 那條路徑在「項目的動作使上層元件於**同一次事件中**重新 render」時會失效：React 對
          // 受信任的離散事件同步 flush effect，於是 `[onClose]` 一變，dismiss 的 effect 就在該次
          // 事件傳遞途中重掛 —— 舊 listener 已移除、新的排到下一個 tick —— 點擊冒到 window 時
          // 已經沒有人在聽（實測：側欄的來源下拉選了 folder 之後不會關）。
          onClick={() => {
            item.onSelect()
            onClose()
          }}
          // `focus:` 與 `hover:` 同樣的底色 —— 少了它，以鍵盤操作時**看不出焦點在哪一項**，
          // 那這個選單就只是「能按 Enter 但你不知道會按到什麼」。`outline-none` 是因為底色
          // 已經足以表達焦點，原生外框在深色主題上很突兀。
          className={`block w-full px-3 py-1 text-left outline-none ${
            item.disabled
              ? 'cursor-not-allowed text-ink-faint opacity-40'
              : `hover:bg-hover focus:bg-hover ${item.tone === 'danger' ? 'text-danger' : 'text-ink-dim'}`
          }`}
        >
          {item.label}
          {item.hint && <span className="block text-2xs text-ink-faint">{item.hint}</span>}
        </button>
      ))}
    </div>
  )
}
