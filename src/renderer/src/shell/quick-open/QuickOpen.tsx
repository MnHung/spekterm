import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { type RootPrefix, baseNameOf, parentOf, stripRoot } from '../files/paths'
import { rankPaths } from './score'

/**
 * 呈現的結果上限。
 *
 * **這個截斷寫在 spec 裡**，因為它會靜默地讓別條驗收失去鑑別力：「某個檔案恰好出現一次」
 * 在結果被截斷時，一個會產生重複項的實作同樣會通過。
 */
const MAX_RESULTS = 50

/**
 * 側欄的檔案快速開啟入口。
 *
 * **以 portal 掛到 `document.body`**：`position: fixed` 若有祖先帶 `transform` / `filter` 就會
 * 改以該祖先為包含塊（與 `VizOverlay` 同一條理由）。側欄最窄可到 240px，結果需要呈現完整
 * 路徑，塞不進去。
 *
 * `role="dialog"` 使它自動被既有的「對話框開啟時導航快捷鍵不生效」尊重 —— 那條明文要求以角色
 * 存在判定、不得逐一列舉。
 *
 * **座標系**：`entries` 與 `onOpen` 一律是**完整的 folder-relative 路徑**（`fs.*` 的定址詞彙），
 * 只有呈現時才 `stripRoot` 剝掉工作目錄前綴。把剝掉的當成權威會讓它與 `fs.*` 分家，而失效方式
 * 是**打開另一個同名的檔案**（見 `paths.ts` 的紀律）。
 */
export function QuickOpen({
  folderId,
  rootPrefix,
  fallbackFocus,
  onOpen,
  onClose,
}: {
  folderId: string
  rootPrefix: RootPrefix
  /** 記住的元素若已離開 DOM，焦點退回這裡。**它必須是可程式聚焦的**（`tabIndex={-1}`）。 */
  fallbackFocus: React.RefObject<HTMLElement | null>
  onOpen: (relPath: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<string[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLLIElement>(null)

  /**
   * 焦點歸還 —— **承重的，不是禮貌**：本能力的觸發條件就是焦點的位置，焦點若落在文件的預設
   * 位置，下一次快捷鍵會靜默失效，而使用者看到的是「這顆鍵時好時壞」。
   *
   * 記住的元素可能已經離開 DOM（開檔會讓檔案樹被檢視器換掉 —— 那正是最常走的一條路），
   * 因此 `isConnected` 的判斷不可省。
   */
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 於 effect 內取值：cleanup 讀 ref 的當下它可能已經變了（side panel 的容器在本元件的
    // 生命週期內是固定的，但那是呼叫端的性質，不該由這裡假設）。
    const fallback = fallbackFocus.current
    inputRef.current?.focus()

    return () => {
      if (previous?.isConnected) previous.focus()
      else fallback?.focus()
    }
  }, [fallbackFocus])

  /** 每次開啟重取，**不快取** —— 旁邊有 agent 一直在寫檔，「剛建好的檔案找不到」是最常見的情境。 */
  useEffect(() => {
    let cancelled = false

    void window.workspace.fs.listFiles(folderId, rootPrefix).then((result) => {
      if (cancelled) return
      if (result.ok) {
        setEntries(result.value)
      } else {
        // **不以空清單呈現失敗** —— 空清單與「這個工作目錄真的沒有檔案」在畫面上無法區分。
        setEntries([])
        setFailed(true)
      }
    })

    return () => {
      cancelled = true
    }
  }, [folderId, rootPrefix])

  const results = useMemo(() => rankPaths(entries ?? [], query, MAX_RESULTS), [entries, query])

  // 查詢改變後，先前的選取位置可能已越界。
  const active = Math.min(selected, Math.max(results.length - 1, 0))

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function move(delta: number): void {
    if (results.length === 0) return
    setSelected((current) => {
      const next = Math.min(current, results.length - 1) + delta
      return Math.max(0, Math.min(results.length - 1, next))
    })
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const target = results[active]
      if (target !== undefined) onOpen(target)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-center bg-scrim pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-label={t('quickOpen.label')}
        className="flex h-fit max-h-[70vh] w-[min(680px,90vw)] flex-col overflow-hidden rounded-lg border border-hairline bg-panel shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
          placeholder={t('quickOpen.placeholder')}
          aria-label={t('quickOpen.placeholder')}
          className="border-b border-hairline bg-transparent px-4 py-3 text-base text-ink outline-none placeholder:text-ink-faint"
        />

        {entries === null ? (
          <p className="px-4 py-3 text-sm text-ink-faint">{t('common.loading')}</p>
        ) : failed ? (
          <p className="px-4 py-3 text-sm text-ink-faint">{t('quickOpen.failed')}</p>
        ) : results.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-faint">{t('quickOpen.noMatch')}</p>
        ) : (
          <ul role="listbox" aria-label={t('quickOpen.results')} className="overflow-y-auto py-1">
            {results.map((relPath, index) => {
              const shown = stripRoot(rootPrefix, relPath)
              const directory = parentOf(shown)
              return (
                <li
                  key={relPath}
                  ref={index === active ? selectedRef : null}
                  role="option"
                  aria-selected={index === active}
                  title={relPath}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    onOpen(relPath)
                  }}
                  className={`flex cursor-pointer items-baseline gap-2 px-4 py-1.5 text-sm ${
                    index === active ? 'bg-hover text-ink' : 'text-ink-dim'
                  }`}
                >
                  <span className="shrink-0">{baseNameOf(shown)}</span>
                  <span className="truncate text-xs text-ink-faint">{directory}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  )
}
