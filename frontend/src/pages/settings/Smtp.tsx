import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Select, SettingsField } from 'fluid-lycoris'
import { api } from '../../api'
import { type SettingsState } from './useSettingsForm'
import { EnvChip, SecretSetting, SettingsPanel, TextSetting } from './ui'

// The SMTP section of the Integrations screen. It takes the screen's form
// rather than mounting useSettingsForm itself: two instances on one screen
// would each seed a copy, and the second save would overwrite the first.
export default function Smtp({
  form,
  set,
  locked,
  dirty,
  clearSecret,
}: {
  form: SettingsState
  set: <K extends keyof SettingsState>(k: K, v: SettingsState[K]) => void
  locked: (k: keyof SettingsState) => boolean
  /** unsaved edits: the test mails with the saved settings, so it waits */
  dirty: boolean
  clearSecret: (k: keyof SettingsState) => void
}) {
  const { t } = useTranslation()
  // a wrong host or sender shows up here instead of as a verification mail
  // that never arrives
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; err?: string }>({})
  const sendTest = async () => {
    setTest({ busy: true })
    try {
      await api.post('/api/settings/smtp/test')
      setTest({ ok: true })
    } catch (e) {
      setTest({ err: e instanceof Error ? e.message : t('app.error') })
    }
  }
  return (
    <SettingsPanel id="email" title={t('settings.email')} desc={t('settings.emailHint')}>
      <TextSetting
        label={t('settings.smtpHost')}
        env={locked('smtpHost')}
        mono
        placeholder="smtp.example.com"
        value={form.smtpHost}
        onChange={(v) => set('smtpHost', v)}
      />
      <div className="sf-2">
        <TextSetting
          label={t('settings.smtpPort')}
          env={locked('smtpPort')}
          mono
          type="number"
          inputMode="numeric"
          min={1}
          max={65535}
          placeholder={form.smtpSecurity === 'tls' ? '465' : form.smtpSecurity === 'none' ? '25' : '587'}
          value={form.smtpPort || ''}
          onChange={(v) => set('smtpPort', Number(v))}
        />
        <SettingsField
          label={t('settings.smtpSecurity')}
          htmlFor="smtp-security"
          badge={<EnvChip show={locked('smtpSecurity')} />}
        >
          <Select
            id="smtp-security"
            value={form.smtpSecurity}
            disabled={locked('smtpSecurity')}
            onChange={(e) => set('smtpSecurity', e.target.value as SettingsState['smtpSecurity'])}
          >
            <option value="starttls">STARTTLS (587)</option>
            <option value="tls">TLS (465)</option>
            <option value="none">{t('settings.smtpSecurityNone')}</option>
          </Select>
        </SettingsField>
        {form.smtpSecurity === 'none' && (
          <p className="sf-issue" role="note">
            {t('settings.smtpNoneWarn')}
          </p>
        )}
        <TextSetting
          label={t('settings.smtpUsername')}
          env={locked('smtpUsername')}
          mono
          autoComplete="off"
          value={form.smtpUsername}
          onChange={(v) => set('smtpUsername', v)}
        />
        <SecretSetting
          label={t('settings.smtpPassword')}
          env={locked('smtpPassword')}
          stored={form.smtpPasswordSet}
          value={form.smtpPassword ?? ''}
          onChange={(v) => set('smtpPassword', v)}
          onRemove={() => clearSecret('smtpPassword')}
        />
      </div>
      <TextSetting
        label={t('settings.smtpFrom')}
        hint={t('settings.smtpFromHint')}
        env={locked('smtpFrom')}
        mono
        placeholder="weebsync@example.com"
        value={form.smtpFrom}
        onChange={(v) => set('smtpFrom', v)}
      />
      <div className="sf-acts">
        <Button size="sm" disabled={test.busy || dirty || !form.smtpHost} onClick={sendTest}>
          {t('settings.smtpTest')}
        </Button>
        <span role="status" className="text-ctl-sm text-ok empty:hidden">
          {test.ok ? t('settings.smtpTestSent') : ''}
        </span>
        {dirty && <span className="text-ctl-sm text-t-muted">{t('settings.smtpTestSaveFirst')}</span>}
      </div>
      {test.err && (
        <p className="sf-issue" role="alert">
          {t('settings.smtpTestFailed', { msg: test.err })}
        </p>
      )}
    </SettingsPanel>
  )
}
