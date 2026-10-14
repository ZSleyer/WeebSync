import { useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from 'fluid-lycoris'
import { PageFooter } from '../../components/PageActions'
import { api } from '../../api'
import { EnvChip } from './ui'

export interface SettingsState {
  baseUrl: string
  maxConcurrent: number
  globalRateLimit: number
  watchIntervalMin: number
  registrationDisabled: boolean
  trustedNetworks: string
  /** proxies whose X-Forwarded-* headers are believed; empty = none */
  trustedProxies: string
  forceHttps: boolean
  authMode: 'password' | 'oidc-only' | 'oidc-auto'
  anilistClientId: string
  anilistSecretSet: boolean
  anilistClientSecret?: string
  anilistRedirectUrl: string
  tmdbApiKeySet: boolean
  tmdbApiKey?: string
  tvdbApiKeySet: boolean
  tvdbApiKey?: string
  animescheduleTokenSet: boolean
  animescheduleToken?: string
  aiBaseUrl: string
  aiModel: string
  aiApiKeySet: boolean
  aiApiKey?: string
  aiSearchUrl: string
  haWebhookUrl: string
  plexUrl: string
  plexTokenSet: boolean
  plexToken?: string
  plexSections: string
  plexSectionSources: string
  plexSectionAnime: string // csv of key:0|1 - does this library hold anime
  plexRoots: string
  plexSkipOwned: boolean
  arrKeySet: boolean // read-only: the Sonarr/Radarr source is on
  arrCompleteDir: string
  arrRoots: string
  plexLibRoots: string // read-only: auto-detected from Plex library locations (flat)
  plexLibraries?: { title: string; roots: string[] }[] // read-only: grouped by library
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
  downloadRoots?: string[] // read-only: local dirs files may be written to
  downloadsEnvSet?: boolean // read-only: WEEBSYNC_DOWNLOADS is set
  onboardingDone?: boolean // first-run wizard finished; write-once
  envLocked: string[]
  // read-only: field -> why its stored value fails the check a save would run
  fieldIssues?: Record<string, string>
}

// secrets are write-only: "" keeps the stored value, "-" clears it
const BLANK_SECRETS = {
  anilistClientSecret: '',
  tmdbApiKey: '',
  tvdbApiKey: '',
  animescheduleToken: '',
  aiApiKey: '',
  plexToken: '',
  oidcClientSecret: '',
  smtpPassword: '',
}

// Shared admin form: each settings sub-page seeds from GET /api/settings and
// saves only the fields that differ from it. The backend keeps what a save
// leaves out and checks only what changed, so a stale tab no longer reverts
// another tab's save, and a value on another page that went bad since does
// not block this one.
export function useSettingsForm() {
  const qc = useQueryClient()
  const { data } = useQuery<SettingsState>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
  })
  // what the form shows until the first edit: the fetched state, secrets blanked
  const seeded = data ? { ...data, ...BLANK_SECRETS, oidcClaim: data.oidcClaim || 'groups' } : null
  const [edited, setForm] = useState<SettingsState | null>(null)
  const form = edited ?? seeded
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    meta: { silent: true },
    mutationFn: (s: SettingsState) =>
      api.put<SettingsState>(
        '/api/settings',
        // compared with the fetched state, not the seeded form: a default the
        // form fills in (oidcClaim "groups") is a change the backend has to get
        Object.fromEntries(
          Object.entries(s).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(data?.[k as keyof SettingsState])),
        ),
      ),
    onSuccess: (fresh) => {
      qc.setQueryData(['settings'], fresh)
      // dependent queries gate UI on the saved config (AniList connect button,
      // Plex sections, SMTP availability, suggestion pages) - refetch them all
      for (const key of [
        'anilist-me',
        'plex-me',
        'plex-sections',
        'email-prefs',
        'anilist-suggestions',
        'plex-suggestions',
        'tmdb-me',
        'tmdb-suggestions',
        'tvdb-me',
        'animeschedule-me',
        'ai-status',
        'ai-models',
        'me',
      ])
        qc.invalidateQueries({ queryKey: [key] })
      // back to the seeded form: a copy of `fresh` would read as dirty as soon
      // as a refetch changed anything in `data` (a false unsaved warning)
      setForm(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 1200)
    },
  })

  const set = <K extends keyof SettingsState>(k: K, v: SettingsState[K]) =>
    setForm((f) => {
      const base = f ?? seeded
      return base ? { ...base, [k]: v } : base
    })

  // field value comes from an env var: input is disabled, EnvBadge shown
  const locked = (k: keyof SettingsState) => form?.envLocked?.includes(k) ?? false

  // unsaved changes: the edits differ from the fetched state, compared with
  // the same blanked secrets
  const dirty = !!edited && !!seeded && JSON.stringify(edited) !== JSON.stringify(seeded)

  // what is wrong with one field: the save just refused it (the backend
  // prefixes the field name), or its stored value broke since it was saved
  // (host no longer resolves); editing the field hides the latter.
  const issue = (k: keyof SettingsState) => {
    const msg = save.error?.message
    if (msg?.startsWith(`${k}:`)) return msg.slice(k.length + 1).trim()
    if (data?.fieldIssues?.[k] && form?.[k] === data[k]) return data.fieldIssues[k]
    return undefined
  }

  // drop the edits: back to the fetched state
  const reset = () => setForm(null)

  return { form, set, save, saved, locked, dirty, issue, reset }
}

// Error line under a field, wired to its input via aria-describedby.
export function FieldIssue({ id, msg }: { id: string; msg?: string }) {
  const { t } = useTranslation()
  if (!msg) return null
  return (
    <span id={id} className="mt-1 block text-err">
      {t('settings.fieldIssue', { msg })}
    </span>
  )
}

// The ENV chip next to a field label whose value an env var forces.
export const EnvBadge = EnvChip

// The save bar: there only while something is unsaved (and for a moment
// after a save, to say it worked). Verwerfen drops the edits. On a phone it
// sits in the shell's footer row above the tab bar, on a desktop it sticks
// to the bottom of the section.
export function SaveBar({
  form,
  save,
  saved,
  dirty,
  reset,
}: {
  form: SettingsState
  save: UseMutationResult<SettingsState, Error, SettingsState>
  saved: boolean
  dirty: boolean
  reset: () => void
}) {
  const { t } = useTranslation()
  if (!dirty && !saved && !save.error) return null
  return (
    <PageFooter>
      <div className="set-save" role="region" aria-label={t('settings.save')}>
        <span role="status">{dirty ? t('settings.unsaved') : saved ? t('settings.saved') : ''}</span>
        {dirty && (
          <>
            <Button
              onClick={() => {
                save.reset()
                reset()
              }}
              disabled={save.isPending}
            >
              {t('common.discard')}
            </Button>
            <Button variant="primary" onClick={() => save.mutate(form)} disabled={save.isPending}>
              {t('settings.save')}
            </Button>
          </>
        )}
        {save.error && <span role="alert">{save.error.message}</span>}
      </div>
    </PageFooter>
  )
}
