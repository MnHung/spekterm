import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { IntakeRulesSnapshot, RuleView } from '../../../../main/ipc/intake'
import { useWorkspaceFolders } from '../useWorkspaceFolders'

/**
 * routing 規則的編輯。
 *
 * ## 為什麼不在 Settings 對話框裡
 *
 * 那個對話框的內容由 `terminal-preferences` 以**列舉**的方式規定，往其中加入本能力的區段
 * 會構成對該能力的修改（前一個這麼做的 change 正是以修改那條 requirement 的方式處理的）。
 * 而規則是**這塊內容自己的設定**，不是終端偏好的一部分。
 *
 * ## 以第三方撰寫的欄位為判準時要標示
 *
 * 以標題／本文／發起者／座標標籤為判準，等於**讓投遞者選擇他的 intake 會落在哪個工作目錄** ——
 * 而他會選許可姿態最寬鬆的那一個。**這件事無法以驗證化解**（那些欄位本來就該是自由文字），
 * 只能讓使用者在建立規則的當下知道他在交出什麼。
 *
 * ## 順序以按鈕調整，不用拖曳
 *
 * `workspace-layout` 對拖曳排序有一條專門的紀律（驗收須用至少三個項目、且往下拖），理由是
 * 「插入點與提交序位差一格」那個 bug **只在往下拖時出現**。用按鈕的話那一整類 bug 在結構上
 * 不存在 —— 而規則的順序不是一個需要手感的操作。spec 要求的是「能調整順序」，不是「能拖曳」。
 */

const CRITERIA: RuleView['criterion'][] = [
  'originKind',
  'originId',
  'title',
  'body',
  'actor',
  'originLabel',
]

export function RulesEditor(): React.JSX.Element {
  const { t } = useTranslation()
  const { folders } = useWorkspaceFolders()
  const [config, setConfig] = useState<IntakeRulesSnapshot>({ rules: [], fallbackFolderId: null })

  const reload = useCallback(() => {
    void window.workspace.intake
      .rules()
      .then(setConfig)
      .catch(() => setConfig({ rules: [], fallbackFolderId: null }))
  }, [])

  useEffect(reload, [reload])

  const persist = useCallback((next: IntakeRulesSnapshot) => {
    setConfig(next)
    void window.workspace.intake.setRules(next)
  }, [])

  const move = useCallback(
    (from: number, to: number) => {
      const rules = [...config.rules]
      const [moved] = rules.splice(from, 1)
      rules.splice(to, 0, moved)
      persist({ ...config, rules })
    },
    [config, persist],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <label className="text-2xs text-ink-dim" htmlFor="intake-fallback">
          {t('intake.rules.fallback')}
        </label>
        <select
          id="intake-fallback"
          aria-label={t('intake.rules.fallback')}
          value={config.fallbackFolderId ?? ''}
          onChange={(event) =>
            persist({ ...config, fallbackFolderId: event.target.value === '' ? null : event.target.value })
          }
          className="rounded border border-hairline bg-shell px-2 py-1 text-2xs text-ink"
        >
          <option value="">—</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={t('intake.rules.add')}
          onClick={() =>
            persist({
              ...config,
              rules: [
                ...config.rules,
                {
                  id: `rule-${Date.now()}`,
                  criterion: 'originId',
                  contains: '',
                  folderId: folders[0]?.id ?? '',
                  spoofable: false,
                },
              ],
            })
          }
          className="cursor-pointer rounded bg-accent/10 px-2 py-1 text-2xs text-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {t('intake.rules.add')}
        </button>
      </div>

      <ul aria-label={t('intake.rules.label')} className="flex flex-col gap-2">
        {config.rules.map((rule, index) => (
          <li
            key={rule.id}
            className="flex items-center gap-2 rounded border border-hairline bg-shell px-2 py-1"
          >
            <select
              aria-label={t('intake.rules.criterion')}
              value={rule.criterion}
              onChange={(event) => {
                const rules = [...config.rules]
                rules[index] = { ...rule, criterion: event.target.value as RuleView['criterion'] }
                persist({ ...config, rules })
              }}
              className="rounded border border-hairline bg-stage px-1 py-0.5 text-2xs text-ink"
            >
              {CRITERIA.map((criterion) => (
                <option key={criterion} value={criterion}>
                  {criterion}
                </option>
              ))}
            </select>
            <input
              aria-label={t('intake.rules.contains')}
              value={rule.contains}
              onChange={(event) => {
                const rules = [...config.rules]
                rules[index] = { ...rule, contains: event.target.value }
                persist({ ...config, rules })
              }}
              className="w-40 rounded border border-hairline bg-stage px-1 py-0.5 text-2xs text-ink"
            />
            <select
              aria-label={t('intake.rules.folder')}
              value={rule.folderId}
              onChange={(event) => {
                const rules = [...config.rules]
                rules[index] = { ...rule, folderId: event.target.value }
                persist({ ...config, rules })
              }}
              className="rounded border border-hairline bg-stage px-1 py-0.5 text-2xs text-ink"
            >
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>

            {/* **可被操縱的判準要標示** —— 見檔頭。 */}
            {rule.spoofable ? (
              <span
                aria-label={t('intake.rules.spoofable')}
                title={t('intake.rules.spoofable')}
                className="rounded bg-hairline/40 px-1 text-2xs text-ink-faint"
              >
                ⚠
              </span>
            ) : null}

            <span className="flex-1" />
            <button
              type="button"
              aria-label={t('intake.rules.moveUp')}
              disabled={index === 0}
              onClick={() => move(index, index - 1)}
              className="cursor-pointer rounded px-1 text-2xs text-ink-dim hover:bg-hairline/40 disabled:cursor-default disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={t('intake.rules.moveDown')}
              disabled={index === config.rules.length - 1}
              onClick={() => move(index, index + 1)}
              className="cursor-pointer rounded px-1 text-2xs text-ink-dim hover:bg-hairline/40 disabled:cursor-default disabled:opacity-30"
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={t('intake.rules.remove')}
              onClick={() => persist({ ...config, rules: config.rules.filter((_, i) => i !== index) })}
              className="cursor-pointer rounded px-1 text-2xs text-ink-dim hover:bg-hairline/40"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
