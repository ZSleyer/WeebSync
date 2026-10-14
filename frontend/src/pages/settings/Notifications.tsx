import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, Select, SettingsField, Switch } from 'fluid-lycoris'
import { api } from '../../api'
import { useFailToast } from '../../components/toast'
import { useWholeSave } from '../../hooks'
import { pushSubscription, pushSupported, subscribePush, unsubscribePush } from '../../push'
import { SettingsPanel, SwitchSetting } from './ui'

// Each change saves at once (no save bar): the push switch, every category
// switch and the delivery cadence.
export default function Notifications() {
  return (
    <>
      <PushSection />
      <CategoriesSection />
    </>
  )
}

interface EmailPrefs {
  enabled: string[]
  available: string[]
  smtpAvailable: boolean
}

interface NotifyPrefs {
  push: string[]
  available: string[]
  pushAvailable: boolean
  freq: string
}

function PushSection() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(false)
  const [state, setState] = useState<'ok' | 'denied' | 'unsupported' | ''>(() => (pushSupported() ? '' : 'unsupported'))
  const [sent, setSent] = useState(false)
  const fail = useFailToast()
  useEffect(() => {
    pushSubscription()
      .then((s) => setEnabled(!!s))
      .catch(() => {})
  }, [])

  const toggle = async (on: boolean) => {
    try {
      if (on) {
        const r = await subscribePush()
        setState(r)
        setEnabled(r === 'ok')
      } else {
        await unsubscribePush()
        setEnabled(false)
        setState('')
      }
    } catch {
      // subscribe/unsubscribe failed (API or PushManager) - reflect reality
      setEnabled(!!(await pushSubscription().catch(() => null)))
    }
  }

  const sendTest = async () => {
    setSent(false)
    try {
      await api.post('/api/push/test', {})
      setSent(true)
    } catch (e) {
      fail(e)
    }
  }

  return (
    <SettingsPanel title={t('settings.push')}>
      <SwitchSetting
        label={t('settings.pushEnable')}
        hint={t('settings.pushHint')}
        checked={enabled}
        disabled={state === 'unsupported'}
        onChange={(on) => void toggle(on)}
      />
      {enabled && (
        <div className="sf-acts">
          <Button size="sm" onClick={sendTest}>
            {t('settings.pushTest')}
          </Button>
          {sent && (
            <span role="status" className="text-ctl-sm text-t-muted">
              {t('settings.pushTestSent')}
            </span>
          )}
        </div>
      )}
      {state === 'denied' && (
        <p className="sf-note text-err" role="alert">
          {t('settings.pushDenied')}
        </p>
      )}
      {state === 'unsupported' && <p className="sf-note">{t('settings.pushUnsupported')}</p>}
    </SettingsPanel>
  )
}

/**
 * The categories as rows, the channels as columns: what this user hears
 * about by push and by mail, in one table. A channel the instance has not
 * set up stays visible but off, with a note under the table why.
 */
export function categoryRows(push: string[], email: string[]): string[] {
  return [...push, ...email.filter((c) => !push.includes(c))]
}

function CategoriesSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const freqId = useId()
  const [error, setError] = useState('')
  const { data: mail } = useQuery<EmailPrefs>({
    queryKey: ['email-prefs'],
    queryFn: () => api.get('/api/auth/email-prefs'),
  })
  const { data: notify } = useQuery<NotifyPrefs>({
    queryKey: ['notify-prefs'],
    queryFn: () => api.get('/api/auth/notify-prefs'),
  })
  const saveMail = useMutation({
    mutationFn: (enabled: string[]) => api.put('/api/auth/email-prefs', { enabled }),
    onSuccess: () => {
      setError('')
      void qc.invalidateQueries({ queryKey: ['email-prefs'] })
    },
    onError: (e: Error) => setError(e.message),
  })
  const update = useWholeSave<NotifyPrefs>('notify-prefs', (p) =>
    api.put('/api/auth/notify-prefs', { push: p.push, freq: p.freq }),
  )
  if (!mail || !notify) return null

  const mailOn = mail.enabled ?? []
  const toggleMail = (cat: string, on: boolean) =>
    saveMail.mutate(on ? [...mailOn, cat] : mailOn.filter((c) => c !== cat))
  const togglePush = (cat: string) =>
    update((p) => ({ ...p, push: p.push.includes(cat) ? p.push.filter((c) => c !== cat) : [...p.push, cat] }))
  const rows = categoryRows(notify.available ?? [], mail.available ?? [])

  return (
    <>
      <SettingsPanel title={t('settings.notifyWhat')} desc={t('settings.notifyWhatDesc')}>
        <table className="cat-t">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">{t('settings.notifyCategory')}</span>
              </th>
              <th scope="col" className="c">
                {t('settings.channelPush')}
              </th>
              <th scope="col" className="c">
                {t('settings.channelEmail')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((cat) => {
              const name = t(`settings.emailCat_${cat}`)
              const pushCan = notify.pushAvailable && notify.available.includes(cat)
              const mailCan = mail.smtpAvailable && (mail.available ?? []).includes(cat)
              return (
                <tr key={cat}>
                  <th scope="row" className="font-normal">
                    {name}
                  </th>
                  <td className="c">
                    <Switch
                      aria-label={t('settings.catByPush', { cat: name })}
                      checked={pushCan && notify.push.includes(cat)}
                      disabled={!pushCan}
                      onChange={() => togglePush(cat)}
                    />
                  </td>
                  <td className="c">
                    <Switch
                      aria-label={t('settings.catByEmail', { cat: name })}
                      checked={mailCan && mailOn.includes(cat)}
                      disabled={!mailCan || saveMail.isPending}
                      onChange={(e) => toggleMail(cat, e.target.checked)}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!notify.pushAvailable && <p className="sf-note">{t('settings.pushUnavailable')}</p>}
        {!mail.smtpAvailable && <p className="sf-note">{t('settings.emailNotConfigured')}</p>}
        {error && (
          <p className="sf-issue" role="alert">
            {error}
          </p>
        )}
      </SettingsPanel>
      {/* the cadence batches mail as well as push, so it is not a push setting */}
      <SettingsPanel title={t('settings.notifyDelivery')}>
        <SettingsField label={t('settings.notifyFreq')} htmlFor={freqId} hint={t('settings.notifyFreqHint')}>
          <Select id={freqId} value={notify.freq} onChange={(e) => update((p) => ({ ...p, freq: e.target.value }))}>
            <option value="instant">{t('settings.freqInstant')}</option>
            <option value="hourly">{t('settings.freqHourly')}</option>
            <option value="daily">{t('settings.freqDaily')}</option>
          </Select>
        </SettingsField>
      </SettingsPanel>
    </>
  )
}
