import { useTranslation } from 'react-i18next'
import { SaveBar, useSettingsForm } from './useSettingsForm'
import { SettingsPanel, TextSetting } from './ui'
import { UnsavedGuard } from '../../hooks/useUnsavedGuard'

// The server stores these as whole numbers and refuses a JSON float, so a
// typed "2.5" is cut to 2 instead of failing the whole save.
const toInt = (v: string) => Math.trunc(Number(v)) || 0

export default function Downloads() {
  const { t } = useTranslation()
  const { form, set, save, saved, dirty, reset, issue } = useSettingsForm()
  if (!form) return null

  return (
    <>
      <UnsavedGuard dirty={dirty} />
      <SettingsPanel title={t('settings.downloads')}>
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
          issue={issue('maxConcurrent')}
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
          issue={issue('globalRateLimit')}
          onChange={(v) => set('globalRateLimit', toInt(v) * 1024)}
        />
      </SettingsPanel>
      <SaveBar form={form} save={save} saved={saved} dirty={dirty} reset={reset} />
    </>
  )
}
