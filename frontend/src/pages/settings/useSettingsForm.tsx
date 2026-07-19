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
  tvdbApiKeySet: boolean
  tvdbApiKey?: string
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
  tvdbApiKey: '',
  plexToken: '',
  oidcClientSecret: '',
  smtpPassword: '',
}

// Shared admin form: each settings sub-page seeds from GET /api/settings and
// saves the full state - safe per-page because PUT validates the complete
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
      // Plex sections, SMTP availability, suggestion pages) - refetch them all
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

  // unsaved changes: form differs from the saved cache. Write-only secrets are
  // always "" in the form (BLANK_SECRETS) but absent from `data`, so seed the
  // baseline the same way before comparing.
  const dirty = !!form && !!data && JSON.stringify(form) !== JSON.stringify({ ...data, ...BLANK_SECRETS, oidcClaim: data.oidcClaim || 'groups' })

  return { form, set, save, saved, locked, dirty }
}

// Lock icon next to a field label whose value is forced by an env var.
// Hover shows "ENV" + hint; the sr-only text carries it for screen readers.
export function EnvBadge({ show }: { show: boolean }) {
  const { t } = useTranslation()
  if (!show) return null
  return (
    <span
      className="ml-1.5 inline-block align-[-1px] text-t-muted"
      title={`ENV - ${t('settings.envLockedHint')}`}
    >
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2a5 5 0 0 0-5 5v3H5v12h14V10h-2V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3H9z" />
      </svg>
      <span className="sr-only">ENV - {t('settings.envLockedHint')}</span>
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
