import { useTranslation } from 'react-i18next'
import { SaveBar, useSettingsForm } from './useSettingsForm'

export default function Transfers() {
  const { t } = useTranslation()
  const { form, set, save, saved } = useSettingsForm()
  if (!form) return null

  return (
    <>
      <section className="t-panel mb-4 p-5" aria-label={t('settings.transfers')}>
        <span className="t-label t-label--accent">{t('settings.transfers')}</span>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-t-muted">
            {t('settings.maxConcurrent')}
            <input
              className="t-input mt-1 font-mono"
              type="number"
              min={1}
              max={20}
              value={form.maxConcurrent}
              onChange={(e) => set('maxConcurrent', Number(e.target.value))}
            />
          </label>
          <label className="text-xs text-t-muted">
            {t('settings.globalLimit')}
            <input
              className="t-input mt-1 font-mono"
              type="number"
              min={0}
              value={Math.round(form.globalRateLimit / 1024)}
              onChange={(e) => set('globalRateLimit', Number(e.target.value) * 1024)}
            />
          </label>
          <label className="text-xs text-t-muted">
            {t('settings.watchInterval')}
            <input
              className="t-input mt-1 font-mono"
              type="number"
              min={5}
              max={1440}
              value={form.watchIntervalMin}
              onChange={(e) => set('watchIntervalMin', Number(e.target.value))}
            />
          </label>
        </div>
      </section>
      <SaveBar form={form} save={save} saved={saved} />
    </>
  )
}
