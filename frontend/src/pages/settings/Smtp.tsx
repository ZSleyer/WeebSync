import { useTranslation } from 'react-i18next'
import { SaveBar, useSettingsForm, type SettingsState } from './useSettingsForm'

export default function Smtp() {
  const { t } = useTranslation()
  const { form, set, save, saved } = useSettingsForm()
  if (!form) return null

  return (
    <>
      <section className="t-panel mb-4 p-5" aria-label={t('settings.email')}>
        <span className="t-label t-label--accent">{t('settings.email')}</span>
        <p className="mt-2 text-xs text-t-muted">{t('settings.emailHint')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-t-muted sm:col-span-2">
            {t('settings.smtpHost')}
            <input
              className="t-input mt-1 font-mono"
              placeholder="smtp.example.com"
              value={form.smtpHost}
              onChange={(e) => set('smtpHost', e.target.value)}
            />
          </label>
          <label className="text-xs text-t-muted">
            {t('settings.smtpPort')}
            <input
              className="t-input mt-1 font-mono"
              type="number"
              min={1}
              max={65535}
              placeholder="587"
              value={form.smtpPort || ''}
              onChange={(e) => set('smtpPort', Number(e.target.value))}
            />
          </label>
          <label className="text-xs text-t-muted">
            {t('settings.smtpSecurity')}
            <span className="t-select-wrap mt-1">
              <select
                className="t-select"
                value={form.smtpSecurity}
                onChange={(e) => set('smtpSecurity', e.target.value as SettingsState['smtpSecurity'])}
              >
                <option value="starttls">STARTTLS (587)</option>
                <option value="tls">TLS (465)</option>
                <option value="none">{t('settings.smtpSecurityNone')}</option>
              </select>
            </span>
          </label>
          <label className="text-xs text-t-muted">
            {t('settings.smtpUsername')}
            <input
              className="t-input mt-1 font-mono"
              autoComplete="off"
              value={form.smtpUsername}
              onChange={(e) => set('smtpUsername', e.target.value)}
            />
          </label>
          <label className="text-xs text-t-muted">
            {t('settings.smtpPassword')}
            <input
              className="t-input mt-1 font-mono"
              type="password"
              autoComplete="off"
              placeholder={form.smtpPasswordSet ? t('settings.secretSet') : t('settings.secretUnset')}
              value={form.smtpPassword ?? ''}
              onChange={(e) => set('smtpPassword', e.target.value)}
            />
          </label>
          <label className="text-xs text-t-muted sm:col-span-2">
            {t('settings.smtpFrom')}
            <input
              className="t-input mt-1 font-mono"
              placeholder="weebsync@example.com"
              value={form.smtpFrom}
              onChange={(e) => set('smtpFrom', e.target.value)}
            />
            <span className="mt-1 block">{t('settings.smtpFromHint')}</span>
          </label>
        </div>
      </section>
      <SaveBar form={form} save={save} saved={saved} />
    </>
  )
}
