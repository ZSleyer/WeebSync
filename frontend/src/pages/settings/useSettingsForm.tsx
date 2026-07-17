import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../api'

export interface SettingsState {
  baseUrl: string
  maxConcurrent: number
  globalRateLimit: number
  watchIntervalMin: number
  registrationDisabled: boolean
  trustedNetworks: string
  authMode: 'password' | 'oidc-only' | 'oidc-auto'
  anilistClientId: string
  anilistSecretSet: boolean
  anilistClientSecret?: string
  anilistRedirectUrl: string
  tmdbApiKeySet: boolean
  tmdbApiKey?: string
  plexUrl: string
  plexTokenSet: boolean
  plexToken?: string
  plexSections: string
  plexSectionSources: string
  oidcProviderName: string
  oidcIssuer: string
  oidcClientId: string
  oidcRedirectUrl: string
  oidcClientSecretSet: boolean
  oidcClientSecret?: string
  oidcClaim: string
  oidcAdminValues: string
  oidcUserValues: string
  oidcEnabled: boolean
  oidcError?: string
  smtpHost: string
  smtpPort: number
  smtpUsername: string
  smtpFrom: string
  smtpSecurity: 'starttls' | 'tls' | 'none'
  smtpPasswordSet: boolean
  smtpPassword?: string
  apiTokenSet?: boolean
  envLocked: string[]
}

// secrets are write-only: "" keeps the stored value, "-" clears it
const BLANK_SECRETS = {
  anilistClientSecret: '',
  tmdbApiKey: '',
  plexToken: '',
  oidcClientSecret: '',
  smtpPassword: '',
}

// Shared admin form: each settings sub-page seeds from GET /api/settings and
// saves the full state — safe per-page because PUT validates the complete
// payload and untouched secrets stay "" (no-op).
export function useSettingsForm() {
  const qc = useQueryClient()
  const { data } = useQuery<SettingsState>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
  })
  const [form, setForm] = useState<SettingsState | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (data && !form)
      setForm({ ...data, ...BLANK_SECRETS, oidcClaim: data.oidcClaim || 'groups' })
  }, [data, form])

  const save = useMutation({
    mutationFn: (s: SettingsState) => api.put<SettingsState>('/api/settings', s),
    onSuccess: (fresh) => {
      qc.setQueryData(['settings'], fresh)
      // dependent queries gate UI on the saved config (AniList connect button,
      // Plex sections, SMTP availability, suggestion pages) — refetch them all
      for (const key of ['anilist-me', 'plex-sections', 'email-prefs', 'anilist-suggestions', 'plex-suggestions', 'tmdb-me', 'tmdb-suggestions'])
        qc.invalidateQueries({ queryKey: [key] })
      setForm({ ...fresh, ...BLANK_SECRETS })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const set = <K extends keyof SettingsState>(k: K, v: SettingsState[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f))

  // field value comes from an env var: input is disabled, EnvBadge shown
  const locked = (k: keyof SettingsState) => form?.envLocked?.includes(k) ?? false

  return { form, set, save, saved, locked }
}

// Badge next to a field label whose value is forced by an env var. Rendered
// inside the <label>, so screen readers announce the hint with the field.
export function EnvBadge({ show }: { show: boolean }) {
  const { t } = useTranslation()
  if (!show) return null
  return (
    <span className="t-label ml-2" title={t('settings.envLockedHint')}>
      ENV<span className="sr-only"> — {t('settings.envLockedHint')}</span>
    </span>
  )
}

export function SaveBar({
  form,
  save,
  saved,
}: {
  form: SettingsState
  save: UseMutationResult<SettingsState, Error, SettingsState>
  saved: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="mb-6 flex items-center gap-3">
      <button className="t-btn t-btn--primary t-cut" onClick={() => save.mutate(form)} disabled={save.isPending}>
        {t('settings.save')}
      </button>
      {saved && <span className="t-label t-label--ok" role="status">{t('settings.saved')}</span>}
      {save.error && (
        <span className="text-sm text-err" role="alert">
          {save.error.message}
        </span>
      )}
    </div>
  )
}
