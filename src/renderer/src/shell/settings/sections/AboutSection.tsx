import { useTranslation } from 'react-i18next'
import { buildInfo } from '../../../build-info'
import { UpdateBlock } from './UpdateBlock'

/**
 * 建置身分（`build-identity`）——「我手上跑的這份，是不是剛才那次打包的產物？」的答案。
 *
 * **唯讀，不是一項偏好。** 放在這個對話框裡是因為這裡已經是「關於這個 app」唯一的入口，
 * 而為一個偶發的問題另開一個入口不划算（`terminal-preferences` 的條文已涵蓋這件事）。
 *
 * **刻意不放狀態列** —— `status-bar` 明文「SHALL NOT 呈現應用程式版本號這類恆為同一個值的
 * 欄位」，本段不推翻那個裁決。
 *
 * `dirty` 的標示是承重的而不是裝飾：工作副本不乾淨時，那份產物**不對應任何 commit**，
 * 下面印出的 commit 指向的是最近一次提交而非實際被建置的原始碼 —— 缺少標示時，那是一個
 * 看起來完全正常的錯誤答案。
 */
export function AboutSection(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <section
      role="group"
      aria-label={t('settings.about')}
      className="text-xs text-ink-faint"
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt>{t('settings.aboutVersion')}</dt>
        <dd className="font-mono text-ink">{buildInfo.version}</dd>
        {buildInfo.mode === 'build' ? (
          <>
            <dt>{t('settings.aboutBuilt')}</dt>
            <dd className="font-mono text-ink">{buildInfo.builtAt}</dd>
            <dt>{t('settings.aboutCommit')}</dt>
            <dd className="font-mono text-ink">
              {buildInfo.commit}
              {buildInfo.dirty ? ` · ${t('settings.aboutDirty')}` : ''}
            </dd>
          </>
        ) : (
          <>
            <dt />
            <dd className="text-ink">{t('settings.aboutDevelopment')}</dd>
          </>
        )}
      </dl>
      <UpdateBlock />
    </section>
  )
}

