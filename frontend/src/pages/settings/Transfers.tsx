import { useTranslation } from 'react-i18next'
import { SaveBar, useSettingsForm } from './useSettingsForm'
import { SettingsPanel, TextSetting } from './ui'
import HwAccelPanel from './HwAccel'
import { UnsavedGuard } from '../../hooks/useUnsavedGuard'

// The server stores these as whole numbers and refuses a JSON float, so a
// typed "2.5" is cut to 2 instead of failing the whole save.
const toInt = (v: string) => Math.trunc(Number(v)) || 0

export default function Transfers() {
  const { t } = useTranslation()
  const { form, set, save, saved, locked, dirty, reset } = useSettingsForm()
  if (!form) return null

  return (
    <>
      <UnsavedGuard dirty={dirty} />
      <SettingsPanel title={t('settings.instance')}>
        <TextSetting
          label={t('settings.baseUrl')}
          hint={t('settings.baseUrlHint')}
          env={locked('baseUrl')}
          mono
          type="url"
          placeholder="https://weebsync.example.com"
          value={form.baseUrl}
          onChange={(v) => set('baseUrl', v)}
        />
      </SettingsPanel>

      <SettingsPanel title={t('settings.transfers')}>
        <TextSetting
          label={t('settings.maxConcurrent')}
          mono
          narrow
          type="number"
          inputMode="numeric"
          min={1}
          max={20}
          step={1}
          value={form.maxConcurrent}
          onChange={(v) => set('maxConcurrent', toInt(v))}
        />
        <TextSetting
          label={t('settings.globalLimit')}
          hint={t('settings.globalLimitHint')}
          mono
          narrow
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={Math.round(form.globalRateLimit / 1024)}
          onChange={(v) => set('globalRateLimit', toInt(v) * 1024)}
        />
        <TextSetting
          label={t('settings.watchInterval')}
          mono
          narrow
          type="number"
          inputMode="numeric"
          min={5}
          max={1440}
          step={1}
          value={form.watchIntervalMin}
          onChange={(v) => set('watchIntervalMin', toInt(v))}
        />
      </SettingsPanel>
      <HwAccelPanel />
      <SaveBar form={form} save={save} saved={saved} dirty={dirty} reset={reset} />
    </>
  )
}
