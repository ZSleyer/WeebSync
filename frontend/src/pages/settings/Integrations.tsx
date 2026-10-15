import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'
import { Badge, Button, Input, Select, SettingsField, Switch } from 'fluid-lycoris'
import './integrations.css'
import { api, ApiError, type PlexAccount as PlexAccountT, type PlexLinkStart } from '../../api'
import { useAiModels } from '../../hooks'
import { SaveBar, useSettingsForm, type SettingsState } from './useSettingsForm'
import { EnvChip, ListSetting, SecretSetting, SettingsPanel, SwitchSetting, TextSetting } from './ui'
import { UnsavedGuard } from '../../hooks/useUnsavedGuard'
import { useConfirm } from '../../components/confirm'
import { useFailToast } from '../../components/toast'
import PlexServerSignIn from '../../components/PlexServerSignIn'
import JellyfinQuickConnect from '../../components/JellyfinQuickConnect'
import { copyText } from '../../clipboard'
import Smtp from './Smtp'

// The five status queries, shared by the panels and the strip on top so
// React Query serves both from one request.
interface AnilistMe {
  configured: boolean
  clientId?: string
  connected: boolean
  name?: string
  expiresAt?: string
  allow?: { list: boolean; social: boolean }
}
interface TmdbMe {
  configured: boolean
  keyValid: boolean
  connected: boolean
  username?: string
  error?: string
}
interface TvdbMe {
  configured: boolean
  connected: boolean
  error?: string
}
interface AnimescheduleMe {
  configured: boolean
  connected: boolean
  error?: string
}
interface PlexMe {
  configured: boolean
  connected: boolean
  username?: string
  server?: string
  error?: string
  kind?: 'plex' | 'jellyfin'
  choose?: boolean
  auth?: 'signin' | 'token' | 'env'
}
interface AiStatus {
  configured: boolean
  connected?: boolean
  error?: string
}
const ANILIST_ME = { queryKey: ['anilist-me'], queryFn: () => api.get<AnilistMe>('/api/anilist/me') }
const TMDB_ME = { queryKey: ['tmdb-me'], queryFn: () => api.get<TmdbMe>('/api/tmdb/me') }
const TVDB_ME = { queryKey: ['tvdb-me'], queryFn: () => api.get<TvdbMe>('/api/tvdb/me') }
const ANIMESCHEDULE_ME = {
  queryKey: ['animeschedule-me'],
  queryFn: () => api.get<AnimescheduleMe>('/api/animeschedule/me'),
}
const PLEX_ME = { queryKey: ['plex-me'], queryFn: () => api.get<PlexMe>('/api/plex/me') }
const AI_STATUS = { queryKey: ['ai-status'], queryFn: () => api.get<AiStatus>('/api/ai/status') }

type Tone = 'ok' | 'err' | 'neutral'

// a working connection, as a line with a check
const Ok = ({ children }: { children: ReactNode }) => <span className="int-ok">{children}</span>

// One dot and a name per provider, coloured by its state, linking to its
// panel: the overview of a long page, and the way to the one that needs work.
function StatusStrip({ smtp, ha, arr }: { smtp: boolean; ha: boolean; arr: boolean }) {
  const { t } = useTranslation()
  const anilist = useQuery(ANILIST_ME).data
  const tmdb = useQuery(TMDB_ME).data
  const tvdb = useQuery(TVDB_ME).data
  const animeschedule = useQuery(ANIMESCHEDULE_ME).data
  const plex = useQuery(PLEX_ME).data
  const ai = useQuery(AI_STATUS).data
  // connected beats an error beats "set up but not tested yet" (the assistant
  // and SMTP have no probe of their own until the user asks for one)
  const state = (connected?: boolean, err?: boolean, configured?: boolean): [Tone, string] =>
    connected
      ? ['ok', t('settings.statusConnected')]
      : err
        ? ['err', t('settings.statusError')]
        : configured
          ? ['ok', t('settings.statusConfigured')]
          : ['neutral', t('settings.statusUnset')]
  const items: [string, string, [Tone, string]][] = [
    ['anilist', 'AniList', state(anilist?.connected)],
    ['tmdb', 'TMDB', state(tmdb?.connected || tmdb?.keyValid, tmdb?.configured && !tmdb.keyValid)],
    ['tvdb', 'TVDB', state(tvdb?.connected, tvdb?.configured)],
    ['animeschedule', 'AnimeSchedule', state(animeschedule?.connected, animeschedule?.configured)],
    // one status answers for whichever server is configured, Plex first
    // one status answers for the server in use; two waiting for a choice
    // both show as set up, the panel above them asks for the pick
    [
      'plex',
      'Plex',
      plex?.choose
        ? state(false, false, true)
        : plex?.kind === 'jellyfin'
          ? state()
          : state(plex?.connected, plex?.configured),
    ],
    [
      'jellyfin',
      'Jellyfin',
      plex?.choose
        ? state(false, false, true)
        : plex?.kind === 'jellyfin'
          ? state(plex.connected, plex.configured)
          : state(),
    ],
    ['arr', 'Sonarr / Radarr', state(false, false, arr)],
    ['ai', t('settings.ai'), state(ai?.connected, !!ai?.error, ai?.configured)],
    ['homeassistant', t('settings.homeAssistant'), state(false, false, ha)],
    ['email', t('settings.email'), state(false, false, smtp)],
  ]
  return (
    <SettingsPanel title={t('settings.svc_status')}>
      <nav aria-label={t('settings.integrationsJump')}>
        <ul className="st-strip">
          {items.map(([id, name, [tone, word]]) => (
            <li key={id}>
              <a href={`#${id}`} title={word}>
                <span aria-hidden className={`dot ${tone === 'neutral' ? '' : tone}`} />
                {name}
                <span className="sr-only">{`: ${word}`}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </SettingsPanel>
  )
}

// a link like /settings/integrations#anilist scrolls to its panel; the panels
// come with the settings, so it looks for the target for a second of frames
function useHashPanel() {
  const { hash } = useLocation()
  useEffect(() => {
    const id = hash.slice(1)
    if (!id) return
    const still =
      matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off'
    let tries = 0
    let raf = 0
    const go = () => {
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' })
      else if (tries++ < 60) raf = requestAnimationFrame(go)
    }
    raf = requestAnimationFrame(go)
    return () => cancelAnimationFrame(raf)
  }, [hash])
}

export default function Integrations() {
  const { t } = useTranslation()
  useHashPanel()
  const { form, set, save, saved, locked, dirty, issue, reset, clearSecret } = useSettingsForm()
  const media = useQuery(PLEX_ME).data
  if (!form) return null
  // the sign-in is the way in; the fields by hand are the fallback and stay
  // folded unless that is how the server is connected right now
  const manual = (kind: 'plex' | 'jellyfin') =>
    !!media?.configured && (media.kind ?? 'plex') === kind && media.auth === 'token'
  const plexSet = form.plexTokenSet && !!form.plexUrl
  const jellyfinSet = form.jellyfinTokenSet && !!form.jellyfinUrl
  // the server the library features run on right now, as the backend sees it
  const active = media?.configured ? (media.kind ?? 'plex') : ''
  const inactive = (kind: 'plex' | 'jellyfin') =>
    active && active !== kind ? (
      <p className="text-ctl-sm text-t-muted">
        {t('settings.mediaServerInactive', { active: active === 'plex' ? 'Plex' : 'Jellyfin' })}
      </p>
    ) : null
  // the library options belong to whichever media server is in use (Plex wins
  // when both are set), so they show under that server's panel
  const library = (
    <>
      <PlexSections
        value={form.plexSections}
        onChange={(v) => set('plexSections', v)}
        sources={form.plexSectionSources}
        onSources={(v) => set('plexSectionSources', v)}
        anime={form.plexSectionAnime}
        onAnime={(v) => set('plexSectionAnime', v)}
        tvdb={form.tvdbApiKeySet}
        libraries={form.plexLibraries}
      />
      <ListSetting
        label={t('settings.plexRoots')}
        hint={t('settings.plexRootsHint')}
        rows={3}
        placeholder={'/media/anime => /mnt/disk1/anime\n/media/serien => /mnt/disk2/serien'}
        value={form.plexRoots}
        onChange={(v) => set('plexRoots', v)}
      />
      <SwitchSetting
        label={t('settings.plexSkipOwned')}
        hint={t('settings.plexSkipOwnedHint')}
        checked={form.plexSkipOwned}
        onChange={(v) => set('plexSkipOwned', v)}
      />
    </>
  )

  // one panel per provider, the connection status as its first line and the
  // fields below it, so the page scans as "what is set up" before "how"
  return (
    <>
      <UnsavedGuard dirty={dirty} />
      <StatusStrip smtp={!!form.smtpHost} ha={!!form.haWebhookUrl} arr={form.arrKeySet} />
      <SettingsPanel id="anilist" title="AniList">
        <AnilistAccount />
        <AnilistWrites />
        <AnilistOwnApp form={form} set={set} locked={locked} clearSecret={clearSecret} />
      </SettingsPanel>

      <SettingsPanel id="tmdb" title="TMDB">
        <TmdbAccount />
        <SecretSetting
          label={t('settings.tmdbApiKey')}
          hint={t('settings.tmdbApiKeyHint')}
          env={locked('tmdbApiKey')}
          stored={form.tmdbApiKeySet}
          value={form.tmdbApiKey ?? ''}
          onChange={(v) => set('tmdbApiKey', v)}
          onRemove={() => clearSecret('tmdbApiKey')}
        />
      </SettingsPanel>

      <SettingsPanel id="tvdb" title="TVDB">
        <TvdbAccount />
        <SecretSetting
          label={t('settings.tvdbApiKey')}
          hint={t('settings.tvdbApiKeyHint')}
          env={locked('tvdbApiKey')}
          stored={form.tvdbApiKeySet}
          value={form.tvdbApiKey ?? ''}
          onChange={(v) => set('tvdbApiKey', v)}
          onRemove={() => clearSecret('tvdbApiKey')}
        />
      </SettingsPanel>

      <SettingsPanel id="animeschedule" title="AnimeSchedule">
        <AnimescheduleAccount />
        <SecretSetting
          label={t('settings.animescheduleToken')}
          hint={t('settings.animescheduleTokenHint')}
          env={locked('animescheduleToken')}
          stored={form.animescheduleTokenSet}
          value={form.animescheduleToken ?? ''}
          onChange={(v) => set('animescheduleToken', v)}
          onRemove={() => clearSecret('animescheduleToken')}
        />
      </SettingsPanel>

      {plexSet && jellyfinSet && (
        <SettingsPanel id="media" title={t('settings.mediaServer')}>
          {media?.choose && (
            <p className="text-ctl-sm text-err" role="alert">
              {t('settings.mediaServerChoose')}
            </p>
          )}
          <SettingsField
            label={t('settings.mediaServerUse')}
            hint={t('settings.mediaServerHint')}
            htmlFor="media-server"
          >
            <Select
              id="media-server"
              value={form.mediaServer}
              disabled={locked('mediaServer')}
              onChange={(e) => set('mediaServer', e.target.value)}
            >
              {!form.mediaServer && (
                <option value="" hidden>
                  {t('settings.mediaServerPick')}
                </option>
              )}
              <option value="plex">Plex</option>
              <option value="jellyfin">Jellyfin</option>
            </Select>
          </SettingsField>
        </SettingsPanel>
      )}

      <SettingsPanel id="plex" title="Plex">
        <PlexAccount kind="plex" />
        {inactive('plex')}
        {!locked('plexUrl') && !locked('plexToken') && (
          <PlexServerSignIn
            connected={form.plexTokenSet && !!form.plexUrl}
            onConnected={(res) => set('plexUrl', res.url)}
          />
        )}
        {active !== 'jellyfin' && !media?.choose && <PlexWatchlistAccount />}
        {/* the sign-in fills both; by hand for a server plex.tv does not list,
            or an address it does not know */}
        <details className="sf-disc" open={locked('plexUrl') || locked('plexToken') || manual('plex') || undefined}>
          <summary>{t('settings.plexManual')}</summary>
          <TextSetting
            label={t('settings.plexUrl')}
            hint={t('settings.plexUrlHint')}
            env={locked('plexUrl')}
            mono
            placeholder="https://plex.example.com"
            value={form.plexUrl}
            onChange={(v) => set('plexUrl', v)}
          />
          <SecretSetting
            label={t('settings.plexToken')}
            hint={t('settings.plexTokenHint')}
            env={locked('plexToken')}
            stored={form.plexTokenSet}
            value={form.plexToken ?? ''}
            onChange={(v) => set('plexToken', v)}
            onRemove={() => clearSecret('plexToken')}
          />
        </details>
        {active === 'plex' && library}
      </SettingsPanel>

      <SettingsPanel id="jellyfin" title="Jellyfin">
        <PlexAccount kind="jellyfin" />
        {inactive('jellyfin')}
        <TextSetting
          label={t('settings.jellyfinUrl')}
          hint={t('settings.jellyfinUrlHint')}
          env={locked('jellyfinUrl')}
          issue={issue('jellyfinUrl')}
          mono
          placeholder="https://jellyfin.example.com"
          value={form.jellyfinUrl}
          onChange={(v) => set('jellyfinUrl', v)}
        />
        {!locked('jellyfinUrl') && !locked('jellyfinToken') && (
          <JellyfinQuickConnect
            server={form.jellyfinUrl}
            disabled={!form.jellyfinUrl}
            label={jellyfinSet ? t('settings.jellyfinSignInOther') : t('settings.jellyfinSignIn')}
          />
        )}
        {active === 'jellyfin' && <JellyfinFavoritesAccount />}
        {/* by hand: an API key from the Jellyfin dashboard, for a server with
            Quick Connect switched off */}
        <details className="sf-disc" open={locked('jellyfinToken') || manual('jellyfin') || undefined}>
          <summary>{t('settings.jellyfinManual')}</summary>
          <SecretSetting
            label={t('settings.jellyfinToken')}
            hint={t('settings.jellyfinTokenHint')}
            env={locked('jellyfinToken')}
            stored={form.jellyfinTokenSet}
            value={form.jellyfinToken ?? ''}
            onChange={(v) => set('jellyfinToken', v)}
            onRemove={() => clearSecret('jellyfinToken')}
          />
        </details>
        {active === 'jellyfin' && library}
      </SettingsPanel>

      <ArrPanel form={form} set={set} />

      <SettingsPanel id="ai" title={t('settings.ai')}>
        <AiAccount />
        <TextSetting
          label={t('settings.aiBaseUrl')}
          hint={t('settings.aiBaseUrlHint')}
          env={locked('aiBaseUrl')}
          issue={issue('aiBaseUrl')}
          mono
          placeholder="http://litellm.example.com:4000/v1"
          value={form.aiBaseUrl}
          onChange={(v) => set('aiBaseUrl', v)}
        />
        <SecretSetting
          label={t('settings.aiApiKey')}
          hint={t('settings.aiApiKeyHint')}
          env={locked('aiApiKey')}
          stored={form.aiApiKeySet}
          value={form.aiApiKey ?? ''}
          onChange={(v) => set('aiApiKey', v)}
          onRemove={() => clearSecret('aiApiKey')}
        />
        <AiModelField value={form.aiModel} locked={locked('aiModel')} onChange={(m) => set('aiModel', m)} />
        <TextSetting
          label={t('settings.aiSearchUrl')}
          hint={t('settings.aiSearchUrlHint')}
          env={locked('aiSearchUrl')}
          issue={issue('aiSearchUrl')}
          mono
          placeholder="http://searxng.example.com:8080"
          value={form.aiSearchUrl}
          onChange={(v) => set('aiSearchUrl', v)}
        />
      </SettingsPanel>

      <SettingsPanel id="homeassistant" title={t('settings.homeAssistant')}>
        <TextSetting
          label={t('settings.haWebhookUrl')}
          hint={t('settings.haWebhookUrlHint')}
          issue={issue('haWebhookUrl')}
          mono
          placeholder="http://homeassistant.local:8123/api/webhook/weebsync"
          value={form.haWebhookUrl}
          onChange={(v) => set('haWebhookUrl', v)}
        />
      </SettingsPanel>

      <Smtp form={form} set={set} locked={locked} dirty={dirty} clearSecret={clearSecret} />
      <SaveBar form={form} save={save} saved={saved} dirty={dirty} reset={reset} />
    </>
  )
}

// Plex library sections: pick which to use and choose the metadata source
// per library (AniList for anime, TMDB for live action). A library without a
// stored choice defaults to AniList when its title contains "anime".
interface PlexSection {
  key: string
  type: string
  title: string
  agent?: string // Plex scanner agent, e.g. tv.plex.agents.series | com.plexapp.agents.hama
  provider?: string // catalog Plex uses for this library: tvdb | tmdb | ''
  ordering?: string // raw showOrdering value, shown as a tooltip
}

// combined source: AniList metadata plus TVDB aired mapping
const ANILIST_TVDB = 'anilist+tvdb'

// TVDB is offered as a third source for show libraries only, and only with a
// key configured: Plex carries no tvdb guid for movies and TVDB has no
// collections, so there is nothing to suggest for a movie library.
function PlexSections({
  value,
  onChange,
  sources,
  onSources,
  anime,
  onAnime,
  tvdb,
  libraries,
}: {
  value: string
  onChange: (v: string) => void
  sources: string
  onSources: (v: string) => void
  anime: string
  onAnime: (v: string) => void
  tvdb: boolean
  libraries?: { title: string; roots: string[] }[] // auto-detected local mounts per library
}) {
  const { t } = useTranslation()
  const { data: sections = [], error } = useQuery<PlexSection[]>({
    queryKey: ['plex-sections'],
    queryFn: () => api.get('/api/plex/sections'),
    retry: false,
  })
  const selected = new Set(
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  const srcMap = new Map(
    sources
      .split(',')
      .map((kv) => kv.trim())
      .filter((kv) => kv.includes(':'))
      .map((kv) => [kv.slice(0, kv.indexOf(':')), kv.slice(kv.indexOf(':') + 1)] as [string, string]),
  )
  // mirrors DefaultSectionSource in the backend: anime keeps AniList, the rest
  // follows the catalog Plex itself uses. An anime library that Plex orders by
  // TVDB starts with the combined source, so the aired mapping is prepared.
  const defaultSource = (s: PlexSection) => {
    const anime = s.title.toLowerCase().includes('anime')
    if (anime) return s.provider === 'tvdb' && s.type === 'show' ? ANILIST_TVDB : 'anilist'
    if (s.type === 'movie') return 'tmdb'
    return s.provider || 'tmdb'
  }
  const sourceOf = (s: PlexSection) => srcMap.get(s.key) ?? defaultSource(s)
  const writeSources = (map: Map<string, string>) =>
    onSources([...map.entries()].map(([k, v]) => `${k}:${v}`).join(','))

  // Which libraries hold anime. Asked explicitly because nothing else answers
  // it reliably: Plex has never heard of AniList, so an anime library is
  // normally scanned and ordered by TVDB like any other. Mirrors sectionKind in
  // the backend - the title and the AniDB-backed legacy agents only preselect.
  const animeMap = new Map(
    anime
      .split(',')
      .map((kv) => kv.trim())
      .filter((kv) => kv.includes(':'))
      .map((kv) => [kv.slice(0, kv.indexOf(':')), kv.slice(kv.indexOf(':') + 1)] as [string, string]),
  )
  const defaultAnime = (s: PlexSection) => {
    const agent = (s.agent ?? '').toLowerCase()
    return s.title.toLowerCase().includes('anime') || agent.includes('hama') || agent.includes('anidb')
  }
  const isAnime = (s: PlexSection) => (animeMap.has(s.key) ? animeMap.get(s.key) === '1' : defaultAnime(s))
  const writeAnime = (map: Map<string, string>) => onAnime([...map.entries()].map(([k, v]) => `${k}:${v}`).join(','))
  const toggle = (s: PlexSection) => {
    const next = new Set(selected)
    const nextSrc = new Map(srcMap)
    const nextAnime = new Map(animeMap)
    if (next.has(s.key)) {
      next.delete(s.key)
      nextSrc.delete(s.key)
      nextAnime.delete(s.key)
    } else {
      next.add(s.key)
      // store the preselection explicitly so the backend never guesses
      nextSrc.set(s.key, defaultSource(s))
      nextAnime.set(s.key, defaultAnime(s) ? '1' : '0')
    }
    onChange([...next].join(','))
    writeSources(nextSrc)
    writeAnime(nextAnime)
  }
  const rootsOf = (s: PlexSection) => libraries?.find((l) => l.title === s.title)?.roots ?? []
  return (
    <SettingsField label={t('settings.plexSections')} hint={t('settings.plexSectionsHint')}>
      {error ? (
        <p className="sf-issue" role="alert">
          {(error as Error).message}
        </p>
      ) : (
        <table className="cat-t">
          <thead>
            <tr>
              <th scope="col">{t('settings.svc_library')}</th>
              <th scope="col">{t('settings.svc_source')}</th>
              <th scope="col" className="c">
                {t('settings.plexSectionAnime')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => {
              const on = selected.has(s.key)
              return (
                <tr key={s.key}>
                  <td>
                    <label>
                      <Switch checked={on} onChange={() => toggle(s)} />
                      <span className="min-w-0">
                        <span className="block">{s.title}</span>
                        {/* the kind, and what Plex itself uses, so the
                            preselection is traceable */}
                        <span className="block text-ctl-sm text-t-muted" title={s.ordering}>
                          {s.type === 'movie' ? t('settings.plexMovies') : t('settings.plexShows')}
                          {s.provider && ` · ${t('settings.plexUses', { name: s.provider.toUpperCase() })}`}
                        </span>
                      </span>
                    </label>
                    {/* auto-detected local mounts for this library */}
                    {rootsOf(s).length > 0 && (
                      <ul className="mt-1 space-y-0.5 pl-[3.25rem] font-mono text-ctl-sm break-all text-t-muted">
                        {rootsOf(s).map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>
                    {on && (
                      <div className="grid gap-1">
                        <Select
                          size="sm"
                          aria-label={t('settings.plexSource', { name: s.title })}
                          value={sourceOf(s) === ANILIST_TVDB ? 'anilist' : sourceOf(s)}
                          onChange={(e) => {
                            const nextSrc = new Map(srcMap)
                            // keep the aired-mapping choice when switching to AniList
                            const keep = e.target.value === 'anilist' && sourceOf(s) === ANILIST_TVDB
                            nextSrc.set(s.key, keep ? ANILIST_TVDB : e.target.value)
                            writeSources(nextSrc)
                          }}
                        >
                          <option value="anilist">AniList</option>
                          <option value="tmdb">TMDB</option>
                          {tvdb && s.type === 'show' && <option value="tvdb">TVDB</option>}
                        </Select>
                        {/* AniList for metadata, TVDB for the aired season
                            mapping: the pairing endless series need */}
                        {tvdb && s.type === 'show' && sourceOf(s).startsWith('anilist') && (
                          <Switch
                            label={t('settings.plexAiredMapping')}
                            labelClassName="text-ctl-sm text-t-secondary"
                            checked={sourceOf(s) === ANILIST_TVDB}
                            onChange={(e) => {
                              const nextSrc = new Map(srcMap)
                              nextSrc.set(s.key, e.target.checked ? ANILIST_TVDB : 'anilist')
                              writeSources(nextSrc)
                            }}
                          />
                        )}
                      </div>
                    )}
                  </td>
                  <td className="c">
                    {on && (
                      <Switch
                        aria-label={t('settings.svc_isAnime', { name: s.title })}
                        checked={isAnime(s)}
                        onChange={(e) => {
                          const nextAnime = new Map(animeMap)
                          nextAnime.set(s.key, e.target.checked ? '1' : '0')
                          writeAnime(nextAnime)
                        }}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </SettingsField>
  )
}

// Own AniList app: only needed when the built-in client id doesn't fit (own
// branding, own rate limit). Collapsed by default so the pin flow above stays
// the obvious path; expanded when any of the three values is already set.
function AnilistOwnApp({
  form,
  set,
  locked,
  clearSecret,
}: {
  form: SettingsState
  set: <K extends keyof SettingsState>(k: K, v: SettingsState[K]) => void
  locked: (k: keyof SettingsState) => boolean
  clearSecret: (k: keyof SettingsState) => void
}) {
  const { t } = useTranslation()
  const { data } = useQuery(ANILIST_ME)
  const open = !!form.anilistClientId || form.anilistSecretSet || !!form.anilistRedirectUrl
  return (
    <details className="sf-disc" open={open || undefined}>
      <summary>{t('settings.anilistOwnApp')}</summary>
      <div className="sf-2">
        <TextSetting
          label={t('settings.anilistClientId')}
          env={locked('anilistClientId')}
          mono
          value={form.anilistClientId}
          onChange={(v) => set('anilistClientId', v)}
        />
        <SecretSetting
          label={t('settings.anilistClientSecret')}
          env={locked('anilistClientSecret')}
          stored={form.anilistSecretSet}
          value={form.anilistClientSecret ?? ''}
          onChange={(v) => set('anilistClientSecret', v)}
          onRemove={() => clearSecret('anilistClientSecret')}
        />
      </div>
      <TextSetting
        label={t('settings.anilistRedirectUrl')}
        hint={t('settings.anilistClientHint')}
        mono
        placeholder={`${window.location.origin}/api/anilist/callback`}
        value={form.anilistRedirectUrl}
        onChange={(v) => set('anilistRedirectUrl', v)}
      />
      {/* OAuth redirect: belongs to the own-app path, needs a saved secret */}
      <div className="sf-acts">
        <Button size="sm" disabled={!data?.configured} onClick={() => (window.location.href = '/api/anilist/connect')}>
          {t('settings.anilistConnect')}
        </Button>
        {!data?.configured && <span className="text-ctl-sm text-t-muted">{t('settings.anilistNotConfigured')}</span>}
      </div>
    </details>
  )
}

// Plex connection status: the stored URL/token are checked against the server
// root, which also names the server and the linked plex.tv account. No connect
// button - Plex is configured by pasting a token above.
// PlexWatchlistAccount drives the plex.tv PIN link flow for the personal
// watchlist (separate from the instance-wide server token above): start a PIN,
// open the plex.tv auth page, poll until the user authorises.
function PlexWatchlistAccount() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery<PlexAccountT>({ queryKey: ['plex-account'], queryFn: () => api.get('/api/plex/account') })
  const [pin, setPin] = useState<PlexLinkStart | null>(null)
  const [expired, setExpired] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval>>(undefined)
  const fail = useFailToast()

  useEffect(() => () => clearInterval(timer.current), [])

  const start = async () => {
    let p: PlexLinkStart
    try {
      p = await api.post<PlexLinkStart>('/api/plex/link/start')
    } catch (e) {
      return fail(e)
    }
    setPin(p)
    setExpired(false)
    window.open(p.url, '_blank', 'noopener')
    clearInterval(timer.current)
    // the server forgets a link request after ten minutes and answers 404
    // from then on; polling stops there instead of asking every 2 s forever
    const until = Date.now() + 10 * 60_000
    const giveUp = () => {
      clearInterval(timer.current)
      setPin(null)
      setExpired(true)
    }
    timer.current = setInterval(async () => {
      if (Date.now() > until) return giveUp()
      try {
        const res = await api.get<PlexAccountT>(`/api/plex/link/poll?id=${p.id}`)
        if (res.linked) {
          clearInterval(timer.current)
          setPin(null)
          qc.invalidateQueries({ queryKey: ['plex-account'] })
        }
      } catch (e) {
        // plex.tv unreachable for a moment: the next round asks again
        if (e instanceof ApiError && e.status === 404) giveUp()
      }
    }, 2000)
  }

  const unlink = async () => {
    await api.del('/api/plex/account')
    qc.invalidateQueries({ queryKey: ['plex-account'] })
  }

  return (
    <div className="sf-acts">
      {data?.linked ? (
        <>
          <Ok>
            <Trans i18nKey="settings.svc_watchlistAs" values={{ user: data.user }} components={{ b: <b /> }} />
          </Ok>
          <Button size="sm" onClick={unlink}>
            {t('settings.plexWatchlistUnlink')}
          </Button>
        </>
      ) : pin ? (
        <span>{t('settings.plexWatchlistPending', { code: pin.code })}</span>
      ) : (
        <>
          <Button size="sm" onClick={start}>
            {t('settings.plexWatchlistLink')}
          </Button>
          {expired && <span role="status">{t('settings.plexWatchlistExpired')}</span>}
        </>
      )}
    </div>
  )
}

// JellyfinFavoritesAccount links the user's own Jellyfin account by Quick
// Connect; its favourites are the watchlist a plex.tv account gives with Plex.
function JellyfinFavoritesAccount() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery<PlexAccountT>({ queryKey: ['plex-account'], queryFn: () => api.get('/api/plex/account') })
  const unlink = async () => {
    await api.del('/api/plex/account')
    qc.invalidateQueries({ queryKey: ['plex-account'] })
  }
  if (data?.linked) {
    return (
      <div className="sf-acts">
        <Ok>
          <Trans i18nKey="settings.svc_watchlistAs" values={{ user: data.user }} components={{ b: <b /> }} />
        </Ok>
        <Button size="sm" onClick={unlink}>
          {t('settings.plexWatchlistUnlink')}
        </Button>
      </div>
    )
  }
  return <JellyfinQuickConnect label={t('settings.jellyfinFavoritesLink')} />
}

// PlexAccount is the connection status line of the server panel named by kind;
// the other panel stays quiet while that server is the one in use.
function PlexAccount({ kind }: { kind: 'plex' | 'jellyfin' }) {
  const { t } = useTranslation()
  const { data } = useQuery(PLEX_ME)
  if (!data || data.choose) return null // the choice panel speaks for both
  if (data.configured && (data.kind ?? 'plex') !== kind) return null
  if (!data.configured && kind === 'jellyfin') return <span>{t('settings.jellyfinNotConfigured')}</span>
  return (
    <div className="sf-acts">
      {data.connected ? (
        // carries a user name and a server name, so its length is the user's,
        // not the designer's - it may run over two lines on a phone
        <Ok>
          <Trans
            i18nKey={data.username ? 'settings.svc_plexAs' : 'settings.svc_plexTo'}
            values={{ user: data.username, server: data.server }}
            components={{ b: <b /> }}
          />
        </Ok>
      ) : data.configured ? (
        <span className="text-ctl-sm text-err" role="alert">
          {data.error}
        </span>
      ) : (
        <span>{t('settings.plexNotConfigured')}</span>
      )}
    </div>
  )
}

// TVDB connection status. The v4 login returns a bare token, so there is no
// account name to show - only whether the key is accepted.
// WeebSync as a source for Sonarr/Radarr (via Prowlarr or directly): one key
// switches the indexer and the download client on, nothing runs without it.
// The key stays readable here: it goes into three apps, and one that was gone
// after a reload got regenerated, which cut all of them off. The folder and
// the path mapping are ordinary settings and go through the save bar.
function ArrPanel({
  form,
  set,
}: {
  form: SettingsState
  set: <K extends keyof SettingsState>(k: K, v: SettingsState[K]) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['settings'] })
  const generate = useMutation({
    mutationFn: () => api.post<{ token: string }>('/api/settings/arr-key'),
    onSuccess: (out) => {
      qc.setQueryData(['arr-key'], out)
      setError('')
      refresh()
    },
    onError: (e: Error) => setError(e.message),
  })
  const revoke = useMutation({
    mutationFn: () => api.del('/api/settings/arr-key'),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['arr-key'] })
      refresh()
    },
    onError: (e: Error) => setError(e.message),
  })
  // the form is a one-shot copy; the live settings follow generate/revoke
  const { data: live } = useQuery<SettingsState>({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') })
  const on = live?.arrKeySet ?? form.arrKeySet
  // 404 for a key minted before keys were kept: only its hash exists
  const stored = useQuery({
    queryKey: ['arr-key'],
    queryFn: () => api.get<{ token: string }>('/api/settings/arr-key'),
    enabled: on,
    retry: false,
  })
  const key = on ? (stored.data?.token ?? '') : ''
  const legacy = on && stored.error instanceof ApiError && stored.error.status === 404
  const origin = window.location.origin
  const host = window.location.hostname
  const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
  const copy = async (what: string, value: string) => {
    const ok = await copyText(value)
    setCopied(ok ? what : '')
    setError(ok ? '' : t('settings.arrCopyFailed'))
  }
  const rows: [string, string, string][] = [
    ['indexer', t('settings.arrIndexerUrl'), `${origin}/api/arr/newznab`],
    ['clientHost', t('settings.arrClientHost'), host],
    ['clientPort', t('settings.arrClientPort'), port],
    ['clientBase', t('settings.arrClientBase'), '/api/arr/sab'],
  ]
  return (
    <SettingsPanel
      id="arr"
      title="Sonarr / Radarr"
      badge={<Badge tone={on ? 'ok' : 'neutral'}>{on ? t('settings.arrOn') : t('settings.arrOff')}</Badge>}
    >
      <p className="sf-note">{t('settings.arrIntro')}</p>
      <div className="sf-acts">
        <Button
          size="sm"
          disabled={generate.isPending}
          onClick={async () => {
            if (!on || (await confirm({ message: t('settings.arrConfirmRegenerate'), destructive: true })))
              generate.mutate()
          }}
        >
          {on ? t('settings.arrKeyRegenerate') : t('settings.arrKeyGenerate')}
        </Button>
        {on && (
          <Button
            size="sm"
            variant="danger"
            disabled={revoke.isPending}
            onClick={async () => {
              if (await confirm({ message: t('settings.arrConfirmOff'), destructive: true })) revoke.mutate()
            }}
          >
            {t('settings.arrTurnOff')}
          </Button>
        )}
      </div>
      {key && (
        <SettingsField label={t('settings.arrKeyShowOnce')} htmlFor="arr-key">
          <div className="sec-row">
            <Input id="arr-key" className="font-mono" readOnly value={key} onFocus={(e) => e.target.select()} />
            <Button size="sm" className="shrink-0" onClick={() => copy('key', key)}>
              {t('settings.apiTokenCopy')}
            </Button>
          </div>
        </SettingsField>
      )}
      {legacy && <p className="sf-note text-warn">{t('settings.arrKeyLegacy')}</p>}
      {on && !form.arrCompleteDir.trim() && (
        <p className="sf-note text-warn" role="alert">
          {t('settings.arrCompleteDirMissing')}
        </p>
      )}
      {on && (
        <>
          <TextSetting
            label={t('settings.arrCompleteDir')}
            hint={t('settings.arrCompleteDirHint')}
            mono
            placeholder="/media/downloads"
            value={form.arrCompleteDir}
            onChange={(v) => set('arrCompleteDir', v)}
          />
          <ListSetting
            label={t('settings.arrRoots')}
            hint={t('settings.arrRootsHint')}
            rows={2}
            placeholder="/data => /mnt/media"
            value={form.arrRoots}
            onChange={(v) => set('arrRoots', v)}
          />
          <SettingsField label={t('settings.arrSetup')} hint={t('settings.arrSetupHint')}>
            <dl className="int-copy">
              {rows.map(([id, label, value]) => (
                <div key={id}>
                  <dt>{label}</dt>
                  <dd>
                    <code>{value}</code>
                    <Button size="sm" className="shrink-0" onClick={() => copy(id, value)}>
                      {t('settings.apiTokenCopy')}
                    </Button>
                  </dd>
                </div>
              ))}
            </dl>
          </SettingsField>
        </>
      )}
      {copied && (
        <p className="sf-note text-ok" role="status">
          {t('settings.apiTokenCopied')}
        </p>
      )}
      {error && (
        <p className="sf-issue" role="alert">
          {error}
        </p>
      )}
    </SettingsPanel>
  )
}

function TvdbAccount() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [testing, setTesting] = useState(false)
  const fail = useFailToast()
  const { data } = useQuery(TVDB_ME)
  // force=1 bypasses the backend's 24h token cache, so a changed key is
  // actually re-tested. fetchQuery writes into the same cache entry.
  const test = async () => {
    setTesting(true)
    try {
      await qc.fetchQuery({
        queryKey: TVDB_ME.queryKey,
        queryFn: () => api.get<TvdbMe>('/api/tvdb/me?force=1'),
        staleTime: 0,
      })
    } catch (e) {
      fail(e)
    } finally {
      setTesting(false)
    }
  }
  if (!data) return null
  return (
    <div className="sf-acts">
      {data.connected ? (
        <Ok>{t('settings.tvdbConnected')}</Ok>
      ) : data.configured ? (
        <span className="text-ctl-sm text-err" role="alert">
          {data.error}
        </span>
      ) : (
        <span>{t('settings.tvdbNotConfigured')}</span>
      )}
      {data.configured && (
        <Button size="sm" disabled={testing} onClick={test}>
          {t('settings.tvdbTest')}
        </Button>
      )}
    </div>
  )
}

function AnimescheduleAccount() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [testing, setTesting] = useState(false)
  const fail = useFailToast()
  const { data } = useQuery(ANIMESCHEDULE_ME)
  // the backend caches nothing here; fetchQuery only writes into the same
  // cache entry so the badge changes
  const test = async () => {
    setTesting(true)
    try {
      await qc.fetchQuery({
        queryKey: ANIMESCHEDULE_ME.queryKey,
        queryFn: () => api.get<AnimescheduleMe>('/api/animeschedule/me?force=1'),
        staleTime: 0,
      })
    } catch (e) {
      fail(e)
    } finally {
      setTesting(false)
    }
  }
  if (!data) return null
  return (
    <div className="sf-acts">
      {data.connected ? (
        <Ok>{t('settings.animescheduleConnected')}</Ok>
      ) : data.configured ? (
        <span className="text-ctl-sm text-err" role="alert">
          {data.error}
        </span>
      ) : (
        <span>{t('settings.animescheduleNotConfigured')}</span>
      )}
      {data.configured && (
        <Button size="sm" disabled={testing} onClick={test}>
          {t('settings.animescheduleTest')}
        </Button>
      )}
    </div>
  )
}

// The model field: a dropdown of what the saved endpoint serves, with the
// stored value kept as an option when the list no longer has it; a plain
// input while no list is available (endpoint not saved yet, or failing).
function AiModelField({ value, locked, onChange }: { value: string; locked: boolean; onChange: (m: string) => void }) {
  const { t } = useTranslation()
  const { data, isFetching, refetch } = useAiModels()
  const models = data?.models ?? []
  const options = value && !models.includes(value) ? [value, ...models] : models
  return (
    <SettingsField
      label={t('settings.aiModel')}
      htmlFor="ai-model"
      hint={t('settings.aiModelHint')}
      badge={<EnvChip show={locked} />}
    >
      <div className="sec-row">
        {options.length > 0 ? (
          <Select
            id="ai-model"
            className="font-mono"
            wrapperClassName="min-w-0 flex-1"
            value={value}
            disabled={locked}
            onChange={(e) => onChange(e.target.value)}
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            id="ai-model"
            className="font-mono"
            placeholder="gpt-4o-mini"
            value={value}
            readOnly={locked}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {data && (
          <Button size="sm" className="shrink-0" disabled={isFetching} onClick={() => refetch()}>
            {t('settings.aiModelsReload')}
          </Button>
        )}
      </div>
      {data?.error && (
        <p className="sf-issue" role="alert">
          {data.error}
        </p>
      )}
    </SettingsField>
  )
}

// Connection state of the assistant endpoint; the test button lists the
// endpoint's models, which exercises URL and key without spending tokens.
function AiAccount() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [testing, setTesting] = useState(false)
  const fail = useFailToast()
  const { data } = useQuery(AI_STATUS)
  const test = async () => {
    setTesting(true)
    try {
      await qc.fetchQuery({
        queryKey: AI_STATUS.queryKey,
        queryFn: () => api.get<AiStatus>('/api/ai/status?force=1'),
        staleTime: 0,
      })
    } catch (e) {
      fail(e)
    } finally {
      setTesting(false)
    }
  }
  if (!data) return null
  return (
    <div className="sf-acts">
      {data.connected ? (
        <Ok>{t('settings.aiConnected')}</Ok>
      ) : data.error ? (
        <span className="text-ctl-sm text-err" role="alert">
          {data.error}
        </span>
      ) : !data.configured ? (
        <span>{t('settings.aiNotConfigured')}</span>
      ) : null}
      {data.configured && (
        <Button size="sm" disabled={testing} onClick={test}>
          {t('settings.aiTest')}
        </Button>
      )}
    </div>
  )
}

// Linked TMDB account of the current user (v3 request-token flow). The
// watchlist suggestions need it; trending works with the API key alone.
function TmdbAccount() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const { data } = useQuery(TMDB_ME)
  if (!data) return null
  return (
    <div className="sf-acts">
      {data.connected ? (
        <>
          <Ok>
            <Trans i18nKey="settings.svc_connectedAs" values={{ name: data.username }} components={{ b: <b /> }} />
          </Ok>
          <Button
            size="sm"
            onClick={async () => {
              try {
                await api.del('/api/tmdb/connect')
                setError('')
                qc.invalidateQueries({ queryKey: ['tmdb-me'] })
                qc.invalidateQueries({ queryKey: ['tmdb-suggestions'] })
              } catch (err) {
                setError(err instanceof Error ? err.message : t('app.error'))
              }
            }}
          >
            {t('settings.tmdbDisconnect')}
          </Button>
        </>
      ) : (
        <>
          {/* the key alone already drives matching and trending, so its state
              is shown even without a linked account */}
          {data.keyValid && <Ok>{t('settings.tmdbConnected')}</Ok>}
          {data.configured && !data.keyValid && (
            <span className="text-ctl-sm text-err" role="alert">
              {data.error}
            </span>
          )}
          <Button size="sm" disabled={!data.configured} onClick={() => (window.location.href = '/api/tmdb/connect')}>
            {t('settings.tmdbConnect')}
          </Button>
          {!data.configured && <span>{t('settings.tmdbConnectHint')}</span>}
        </>
      )}
      {error && (
        <span className="text-ctl-sm text-err" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

// Linked AniList account of the current user (OAuth). Connecting redirects
// to AniList; tokens live about a year, so an expiry hint prompts re-connect.
/**
 * What WeebSync may change on the linked AniList account, one switch each,
 * off until the user turns it on. Saved at once, not with the form below:
 * a permission is a decision of its own, not a draft.
 */
function AnilistWrites() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const fail = useFailToast()
  const { data } = useQuery(ANILIST_ME)
  const save = useMutation({
    mutationFn: (patch: { list?: boolean; social?: boolean }) =>
      api.put<{ list: boolean; social: boolean }>('/api/anilist/permissions', patch),
    onMutate: (patch) => {
      const prev = qc.getQueryData<AnilistMe>(['anilist-me'])
      if (prev)
        qc.setQueryData<AnilistMe>(['anilist-me'], {
          ...prev,
          allow: { list: false, social: false, ...prev.allow, ...patch },
        })
      return prev
    },
    onError: (e, _patch, prev) => {
      if (prev) qc.setQueryData(['anilist-me'], prev)
      fail(e)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['anilist-me'] }),
  })
  if (!data?.connected) return null
  return (
    <div id="anilist-writes" className="grid gap-1">
      <SwitchSetting
        label={t('settings.anilistWriteList')}
        hint={t('settings.anilistWriteListHint')}
        checked={!!data.allow?.list}
        onChange={(v) => save.mutate({ list: v })}
      />
      <SwitchSetting
        label={t('settings.anilistWriteSocial')}
        hint={t('settings.anilistWriteSocialHint')}
        checked={!!data.allow?.social}
        onChange={(v) => save.mutate({ social: v })}
      />
    </div>
  )
}

function AnilistAccount() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [pinToken, setPinToken] = useState('')
  const { data } = useQuery(ANILIST_ME)
  const connectPin = useMutation({
    mutationFn: () => api.post('/api/anilist/token', { token: pinToken }),
    onSuccess: () => {
      setPinToken('')
      setError('')
      qc.invalidateQueries({ queryKey: ['anilist-me'] })
      qc.invalidateQueries({ queryKey: ['anilist-suggestions'] })
    },
    onError: (e: Error) => setError(e.message),
  })
  const [now] = useState(() => Date.now())
  if (!data) return null
  const expires = data.expiresAt ? Date.parse(data.expiresAt.replace(' ', 'T') + 'Z') : 0
  const expiringSoon = expires > 0 && expires - now < 30 * 86_400_000
  return (
    <div className="sf-acts">
      {data.connected ? (
        <>
          <Ok>
            <Trans i18nKey="settings.svc_connectedAs" values={{ name: data.name }} components={{ b: <b /> }} />
          </Ok>
          {expires > 0 && (
            <span className={expiringSoon ? 'text-warn' : ''}>
              {t('settings.anilistExpires', { date: new Date(expires).toLocaleDateString() })}
              {expiringSoon && ` ${t('settings.anilistReconnect')}`}
            </span>
          )}
          <Button
            size="sm"
            onClick={async () => {
              try {
                await api.del('/api/anilist/connect')
                setError('')
                qc.invalidateQueries({ queryKey: ['anilist-me'] })
                qc.invalidateQueries({ queryKey: ['anilist-suggestions'] })
              } catch (err) {
                setError(err instanceof Error ? err.message : t('app.error'))
              }
            }}
          >
            {t('settings.anilistDisconnect')}
          </Button>
          {error && (
            <span className="text-ctl-sm text-err" role="alert">
              {error}
            </span>
          )}
        </>
      ) : (
        <div className="grid w-full grid-cols-1 gap-2">
          {/* pin flow: token pasted by the user - no secret, no redirect URL.
              This is the default path; it works with the built-in client id,
              so nothing has to be configured first. */}
          <SettingsField
            label={t('settings.anilistPinLabel')}
            htmlFor="anilist-pin"
            className="!mt-0"
            hint={
              data.clientId ? (
                <a
                  className="t-link"
                  href={`https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(data.clientId)}&response_type=token`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('settings.anilistPinGet')}
                </a>
              ) : (
                t('settings.anilistPinHint')
              )
            }
          >
            <div className="sec-row">
              <Input
                id="anilist-pin"
                className="font-mono"
                type="password"
                autoComplete="off"
                placeholder={t('settings.anilistPinPlaceholder')}
                value={pinToken}
                onChange={(e) => setPinToken(e.target.value)}
              />
              <Button
                size="sm"
                className="shrink-0"
                disabled={!pinToken.trim() || connectPin.isPending}
                onClick={() => connectPin.mutate()}
              >
                {t('settings.anilistPinConnect')}
              </Button>
            </div>
          </SettingsField>
          {error && (
            <span className="text-ctl-sm text-err" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
