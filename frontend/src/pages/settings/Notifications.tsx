import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../api'
import { pushSubscription, pushSupported, subscribePush, unsubscribePush } from '../../push'

export default function Notifications() {
  return (
    <>
      <EmailPrefsSection />
      <PushSection />
      <NotifyPrefsSection />
    </>
  )
}

interface EmailPrefs {
  enabled: string[]
  available: string[]
  smtpAvailable: boolean
}

function EmailPrefsSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const { data } = useQuery<EmailPrefs>({
    queryKey: ['email-prefs'],
    queryFn: () => api.get('/api/auth/email-prefs'),
  })
  const save = useMutation({
    mutationFn: (enabled: string[]) => api.put('/api/auth/email-prefs', { enabled }),
    onSuccess: () => {
      setError('')
      qc.invalidateQueries({ queryKey: ['email-prefs'] })
    },
    onError: (e: Error) => setError(e.message),
  })
  if (!data) return null

  const enabled = data.enabled ?? []
  const toggle = (cat: string, on: boolean) => {
    const next = on ? [...enabled, cat] : enabled.filter((c) => c !== cat)
    save.mutate(next)
  }

  return (
    <section className="t-panel mb-4 p-5" aria-label={t('settings.emailNotifications')}>
      <span className="t-label t-label--accent">{t('settings.emailNotifications')}</span>
      {!data.smtpAvailable ? (
        <p className="mt-2 text-sm text-t-secondary">{t('settings.emailNotConfigured')}</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-2">
          {(data.available ?? []).map((cat) => (
            <label key={cat} className="flex items-center gap-2 text-sm text-t-secondary">
              <input
                type="checkbox"
                checked={enabled.includes(cat)}
                disabled={save.isPending}
                onChange={(e) => toggle(cat, e.target.checked)}
              />
              {t(`settings.emailCat_${cat}`)}
            </label>
          ))}
        </div>
      )}
      {error && (
        <p className="mt-2 text-xs text-err" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function PushSection() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(false)
  const [state, setState] = useState<'ok' | 'denied' | 'unsupported' | ''>('')
  const [sent, setSent] = useState(false)
  useEffect(() => {
    pushSubscription().then((s) => setEnabled(!!s)).catch(() => {})
    if (!pushSupported()) setState('unsupported')
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
    await api.post('/api/push/test', {})
    setSent(true)
  }

  return (
    <section className="t-panel mb-4 p-5" aria-label={t('settings.notifications')}>
      <span className="t-label t-label--accent">{t('settings.notifications')}</span>
      <label className="mt-3 flex items-center gap-2 text-sm text-t-secondary">
        <input
          type="checkbox"
          checked={enabled}
          disabled={state === 'unsupported'}
          onChange={(e) => toggle(e.target.checked)}
        />
        {t('settings.pushEnable')}
      </label>
      <p className="mt-2 text-xs text-t-muted">{t('settings.pushHint')}</p>
      {enabled && (
        <p className="mt-2 flex items-center gap-3">
          <button type="button" className="t-btn t-btn--sm" onClick={sendTest}>
            {t('settings.pushTest')}
          </button>
          {sent && <span className="text-xs text-t-muted">{t('settings.pushTestSent')}</span>}
        </p>
      )}
      {state === 'denied' && (
        <p className="mt-1 text-xs text-err" role="alert">
          {t('settings.pushDenied')}
        </p>
      )}
      {state === 'unsupported' && <p className="mt-1 text-xs text-t-muted">{t('settings.pushUnsupported')}</p>}
    </section>
  )
}

interface NotifyPrefs {
  push: string[]
  available: string[]
  pushAvailable: boolean
  freq: string
}

// NotifyPrefsSection: per-category web-push opt-ins plus the delivery cadence
// (instant / hourly / daily) that batches the notification digest.
function NotifyPrefsSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery<NotifyPrefs>({ queryKey: ['notify-prefs'], queryFn: () => api.get('/api/auth/notify-prefs') })
  const save = useMutation({
    mutationFn: (body: { push: string[]; freq: string }) => api.put('/api/auth/notify-prefs', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-prefs'] }),
  })
  if (!data) return null

  const togglePush = (cat: string) => {
    const push = data.push.includes(cat) ? data.push.filter((c) => c !== cat) : [...data.push, cat]
    save.mutate({ push, freq: data.freq })
  }
  const setFreq = (freq: string) => save.mutate({ push: data.push, freq })

  return (
    <section className="t-panel mb-4 p-5" aria-label={t('settings.pushCategories')}>
      <span className="t-label t-label--accent">{t('settings.pushCategories')}</span>
      {data.pushAvailable ? (
        <div className="mt-3 space-y-1.5">
          {data.available.map((cat) => (
            <label key={cat} className="flex items-center gap-2 text-sm text-t-secondary">
              <input type="checkbox" checked={data.push.includes(cat)} onChange={() => togglePush(cat)} />
              {t(`settings.emailCat_${cat}`)}
            </label>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-t-muted">{t('settings.pushUnavailable')}</p>
      )}
      <label className="mt-4 flex items-center gap-2 text-sm text-t-secondary">
        {t('settings.notifyFreq')}
        <select className="t-input t-input--sm" value={data.freq} onChange={(e) => setFreq(e.target.value)}>
          <option value="instant">{t('settings.freqInstant')}</option>
          <option value="hourly">{t('settings.freqHourly')}</option>
          <option value="daily">{t('settings.freqDaily')}</option>
        </select>
      </label>
      <p className="mt-2 text-xs text-t-muted">{t('settings.notifyFreqHint')}</p>
    </section>
  )
}
