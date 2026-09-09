import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Input, Panel, ROW_GRID, Select } from '@weebsync/design-system'
import { api, type PlexAccount as PlexAccountT, type PlexLinkStart } from '../../api'
import { useAiModels } from '../../hooks'
import { EnvBadge, SaveBar, useSettingsForm, type SettingsState } from './useSettingsForm'
import { UnsavedGuard } from '../../hooks/useUnsavedGuard'
import Smtp from './Smtp'


// The five status queries, shared by the panels and the strip on top so
// React Query serves both from one request.
interface AnilistMe {
  configured: boolean
  clientId?: string
  connected: boolean
  name?: string
  expiresAt?: string
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
interface PlexMe {
  configured: boolean
  connected: boolean
  username?: string
  server?: string
  error?: string
}
interface AiStatus {
  configured: boolean
  connected?: boolean
  error?: string
}
const ANILIST_ME = { queryKey: ['anilist-me'], queryFn: () => api.get<AnilistMe>('/api/anilist/me') }
const TMDB_ME = { queryKey: ['tmdb-me'], queryFn: () => api.get<TmdbMe>('/api/tmdb/me') }
const TVDB_ME = { queryKey: ['tvdb-me'], queryFn: () => api.get<TvdbMe>('/api/tvdb/me') }
const PLEX_ME = { queryKey: ['plex-me'], queryFn: () => api.get<PlexMe>('/api/plex/me') }
const AI_STATUS = { queryKey: ['ai-status'], queryFn: () => api.get<AiStatus>('/api/ai/status') }

type Tone = 'ok' | 'err' | 'neutral'

// One chip per provider, coloured by its state, linking to its panel: the
// overview of a long page, and the way to reach the one that needs work.
function StatusStrip({ smtp }: { smtp: boolean }) {
  const { t } = useTranslation()
  const anilist = useQuery(ANILIST_ME).data
  const tmdb = useQuery(TMDB_ME).data
  const tvdb = useQuery(TVDB_ME).data
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
  const chips: [string, string, [Tone, string]][] = [
    ['anilist', 'AniList', state(anilist?.connected)],
    ['tmdb', 'TMDB', state(tmdb?.connected || tmdb?.keyValid, tmdb?.configured && !tmdb.keyValid)],
    ['tvdb', 'TVDB', state(tvdb?.connected, tvdb?.configured)],
    ['plex', t('settings.plex'), state(plex?.connected, plex?.configured)],
    ['ai', t('settings.ai'), state(ai?.connected, !!ai?.error, ai?.configured)],
    ['email', t('settings.email'), state(false, false, smtp)],
  ]
  return (
    <nav aria-label={t('settings.integrationsJump')} className="mb-4 flex flex-wrap gap-2">
      {chips.map(([id, name, [tone, word]]) => (
        <Badge key={id} as="a" href={`#${id}`} tone={tone}>
          {name} · {word}
        </Badge>
      ))}
    </nav>
  )
}

export default function Integrations() {
  const { t } = useTranslation()
  const { form, set, save, saved, locked, dirty } = useSettingsForm()
  if (!form) return null

  // one panel per provider, the connection status as its first row and the
  // fields below it, so the page scans as "what is set up" before "how"
  return (
    <>
      <UnsavedGuard dirty={dirty} />
      <StatusStrip smtp={!!form.smtpHost} />
      <Panel as="section" id="anilist" className="mb-4 p-5" aria-label="AniList">
        <Badge tone="accent">AniList</Badge>
        <div className="mt-3 grid grid-cols-1 gap-4">
          <AnilistAccount />
          <AnilistOwnApp form={form} set={set} locked={locked} />
        </div>
      </Panel>

      <Panel as="section" id="tmdb" className="mb-4 p-5" aria-label="TMDB">
        <Badge tone="accent">TMDB</Badge>
        <div className="mt-3 grid grid-cols-1 gap-4">
          <TmdbAccount />
          <label className="text-xs text-t-muted">
            {t('settings.tmdbApiKey')}
            <EnvBadge show={locked('tmdbApiKey')} />
            <Input
              className="mt-1 font-mono"
              type="password"
              autoComplete="off"
              placeholder={form.tmdbApiKeySet ? t('settings.secretSet') : t('settings.secretUnset')}
              value={form.tmdbApiKey ?? ''}
              disabled={locked('tmdbApiKey')}
              onChange={(e) => set('tmdbApiKey', e.target.value)}
            />
            <span className="mt-1 block">{t('settings.tmdbApiKeyHint')}</span>
          </label>
        </div>
      </Panel>

      <Panel as="section" id="tvdb" className="mb-4 p-5" aria-label="TVDB">
        <Badge tone="accent">TVDB</Badge>
        <div className="mt-3 grid grid-cols-1 gap-4">
          <TvdbAccount />
          <label className="text-xs text-t-muted">
            {t('settings.tvdbApiKey')}
            <EnvBadge show={locked('tvdbApiKey')} />
            <Input
              className="mt-1 font-mono"
              type="password"
              autoComplete="off"
              placeholder={form.tvdbApiKeySet ? t('settings.secretSet') : t('settings.secretUnset')}
              value={form.tvdbApiKey ?? ''}
              disabled={locked('tvdbApiKey')}
              onChange={(e) => set('tvdbApiKey', e.target.value)}
            />
            <span className="mt-1 block">{t('settings.tvdbApiKeyHint')}</span>
          </label>
        </div>
      </Panel>

      <Panel as="section" id="plex" className="mb-4 p-5" aria-label={t('settings.plex')}>
        <Badge tone="accent">{t('settings.plex')}</Badge>
        <div className="mt-3 grid grid-cols-1 gap-4">
          <PlexAccount />
          <PlexWatchlistAccount />
          <div className={ROW_GRID}>
            <label className="text-xs text-t-muted">
              {t('settings.plexUrl')}
              <EnvBadge show={locked('plexUrl')} />
              <Input
                className="mt-1 font-mono"
                placeholder="https://plex.example.com"
                value={form.plexUrl}
                disabled={locked('plexUrl')}
                onChange={(e) => set('plexUrl', e.target.value)}
              />
              <span className="mt-1 block">{t('settings.plexUrlHint')}</span>
            </label>
            <label className="text-xs text-t-muted">
              {t('settings.plexToken')}
              <EnvBadge show={locked('plexToken')} />
              <Input
                className="mt-1 font-mono"
                type="password"
                autoComplete="off"
                placeholder={form.plexTokenSet ? t('settings.secretSet') : t('settings.secretUnset')}
                value={form.plexToken ?? ''}
                disabled={locked('plexToken')}
                onChange={(e) => set('plexToken', e.target.value)}
              />
              <span className="mt-1 block">{t('settings.plexTokenHint')}</span>
            </label>
          </div>
          {form.plexTokenSet && form.plexUrl && (
            // the library block is the longest thing on the page: framed like
            // the OIDC block on Security, so it reads as one unit
            <fieldset className="rounded-lg border border-border-subtle p-3">
              <Badge as="legend">{t('settings.plexSections')}</Badge>
              <div className="grid grid-cols-1 gap-4">
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
                <label className="text-xs text-t-muted">
                  {t('settings.plexRoots')}
                  <textarea
                    className="t-input mt-1 font-mono"
                    rows={3}
                    placeholder={'/media/anime => /mnt/disk1/anime\n/media/serien => /mnt/disk2/serien'}
                    value={form.plexRoots}
                    onChange={(e) => set('plexRoots', e.target.value)}
                  />
                  <span className="mt-1 block">{t('settings.plexRootsHint')}</span>
                </label>
              </div>
            </fieldset>
          )}
        </div>
      </Panel>

      <Panel as="section" id="ai" className="mb-4 p-5" aria-label={t('settings.ai')}>
        <Badge tone="accent">{t('settings.ai')}</Badge>
        <div className="mt-3 grid grid-cols-1 gap-4">
          <AiAccount />
          <div className={ROW_GRID}>
            <label className="text-xs text-t-muted sm:col-span-2">
              {t('settings.aiBaseUrl')}
              <EnvBadge show={locked('aiBaseUrl')} />
              <Input
                className="mt-1 font-mono"
                placeholder="http://litellm.example.com:4000/v1"
                value={form.aiBaseUrl}
                disabled={locked('aiBaseUrl')}
                onChange={(e) => set('aiBaseUrl', e.target.value)}
              />
              <span className="mt-1 block">{t('settings.aiBaseUrlHint')}</span>
            </label>
            <label className="text-xs text-t-muted">
              {t('settings.aiApiKey')}
              <EnvBadge show={locked('aiApiKey')} />
              <Input
                className="mt-1 font-mono"
                type="password"
                autoComplete="off"
                placeholder={form.aiApiKeySet ? t('settings.secretSet') : t('settings.secretUnset')}
                value={form.aiApiKey ?? ''}
                disabled={locked('aiApiKey')}
                onChange={(e) => set('aiApiKey', e.target.value)}
              />
              <span className="mt-1 block">{t('settings.aiApiKeyHint')}</span>
            </label>
            <AiModelField value={form.aiModel} locked={locked('aiModel')} onChange={(m) => set('aiModel', m)} />
            <label className="text-xs text-t-muted sm:col-span-2">
              {t('settings.aiSearchUrl')}
              <EnvBadge show={locked('aiSearchUrl')} />
              <Input
                className="mt-1 font-mono"
                placeholder="http://searxng.example.com:8080"
                value={form.aiSearchUrl}
                disabled={locked('aiSearchUrl')}
                onChange={(e) => set('aiSearchUrl', e.target.value)}
              />
              <span className="mt-1 block">{t('settings.aiSearchUrlHint')}</span>
            </label>
          </div>
        </div>
      </Panel>

      <Smtp form={form} set={set} locked={locked} />
      <SaveBar form={form} save={save} saved={saved} />
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
  const selected = new Set(value.split(',').map((s) => s.trim()).filter(Boolean))
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
  const writeAnime = (map: Map<string, string>) =>
    onAnime([...map.entries()].map(([k, v]) => `${k}:${v}`).join(','))
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
  if (error)
    return (
      <p className="text-xs text-err" role="alert">
        {(error as Error).message}
      </p>
    )
  return (
    <div className="text-xs text-t-muted">
      <ul className="grid grid-cols-1 gap-1.5">
        {sections.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 items-center gap-1.5 text-t-secondary">
              <input type="checkbox" checked={selected.has(s.key)} onChange={() => toggle(s)} />
              <span className="truncate">{s.title}</span>
            </label>
            <Badge>{s.type === 'movie' ? t('settings.plexMovies') : t('settings.plexShows')}</Badge>
            {/* what Plex itself uses, so the preselection is traceable */}
            {s.provider && (
              <Badge title={s.ordering}>
                {t('settings.plexUses', { name: s.provider.toUpperCase() })}
              </Badge>
            )}
            {selected.has(s.key) && (
              <>
                <Select
                  className="py-1 text-xs"
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
                {/* AniList for metadata, TVDB for the aired season mapping -
                    the pairing endless series need */}
                {tvdb && s.type === 'show' && sourceOf(s).startsWith('anilist') && (
                  <label className="flex items-center gap-1.5 text-t-secondary">
                    <input
                      type="checkbox"
                      checked={sourceOf(s) === ANILIST_TVDB}
                      onChange={(e) => {
                        const nextSrc = new Map(srcMap)
                        nextSrc.set(s.key, e.target.checked ? ANILIST_TVDB : 'anilist')
                        writeSources(nextSrc)
                      }}
                    />
                    {t('settings.plexAiredMapping')}
                  </label>
                )}
                <label className="flex items-center gap-1.5 text-t-secondary">
                  <input
                    type="checkbox"
                    checked={isAnime(s)}
                    onChange={(e) => {
                      const nextAnime = new Map(animeMap)
                      nextAnime.set(s.key, e.target.checked ? '1' : '0')
                      writeAnime(nextAnime)
                    }}
                  />
                  {t('settings.plexSectionAnime')}
                </label>
              </>
            )}
            {/* auto-detected local mounts for this library, straight under it */}
            {(() => {
              const roots = libraries?.find((l) => l.title === s.title)?.roots ?? []
              if (!roots.length) return null
              return (
                <ul className="w-full space-y-0.5 pl-6 font-mono text-[11px] text-t-muted">
                  {roots.map((p) => (
                    <li key={p} className="break-all">
                      {p}
                    </li>
                  ))}
                </ul>
              )
            })()}
          </li>
        ))}
      </ul>
      <p className="mt-1.5">{t('settings.plexSectionsHint')}</p>
    </div>
  )
}

// Own AniList app: only needed when the built-in client id doesn't fit (own
// branding, own rate limit). Collapsed by default so the pin flow above stays
// the obvious path; expanded when any of the three values is already set.
function AnilistOwnApp({
  form,
  set,
  locked,
}: {
  form: SettingsState
  set: <K extends keyof SettingsState>(k: K, v: SettingsState[K]) => void
  locked: (k: keyof SettingsState) => boolean
}) {
  const { t } = useTranslation()
  const { data } = useQuery(ANILIST_ME)
  const [open, setOpen] = useState(
    !!form.anilistClientId || form.anilistSecretSet || !!form.anilistRedirectUrl,
  )
  return (
    <div className="text-xs text-t-muted">
      <button
        type="button"
        className="flex min-h-6 items-center gap-1.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown aria-hidden size="1em" className="shrink-0 text-accent" />
        ) : (
          <ChevronRight aria-hidden size="1em" className="shrink-0 text-accent" />
        )}
        <span>{t('settings.anilistOwnApp')}</span>
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-1 gap-3 rounded-lg border border-border-subtle bg-bg-secondary/40 p-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-t-muted">
              {t('settings.anilistClientId')}
              <EnvBadge show={locked('anilistClientId')} />
              <Input
                className="mt-1 font-mono"
                value={form.anilistClientId}
                disabled={locked('anilistClientId')}
                onChange={(e) => set('anilistClientId', e.target.value)}
              />
            </label>
            <label className="text-xs text-t-muted">
              {t('settings.anilistClientSecret')}
              <EnvBadge show={locked('anilistClientSecret')} />
              <Input
                className="mt-1 font-mono"
                type="password"
                autoComplete="off"
                placeholder={form.anilistSecretSet ? t('settings.secretSet') : t('settings.secretUnset')}
                value={form.anilistClientSecret ?? ''}
                disabled={locked('anilistClientSecret')}
                onChange={(e) => set('anilistClientSecret', e.target.value)}
              />
            </label>
          </div>
          <label className="text-xs text-t-muted">
            {t('settings.anilistRedirectUrl')}
            <Input
              className="mt-1 font-mono"
              placeholder={`${window.location.origin}/api/anilist/callback`}
              value={form.anilistRedirectUrl}
              onChange={(e) => set('anilistRedirectUrl', e.target.value)}
            />
            <span className="mt-1 block">{t('settings.anilistClientHint')}</span>
          </label>
          {/* OAuth redirect: belongs to the own-app path, needs a saved secret */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!data?.configured}
              onClick={() => (window.location.href = '/api/anilist/connect')}
            >
              {t('settings.anilistConnect')}
            </Button>
            {!data?.configured && <span>{t('settings.anilistNotConfigured')}</span>}
          </div>
        </div>
      )}
    </div>
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
  const timer = useRef<ReturnType<typeof setInterval>>(undefined)

  useEffect(() => () => clearInterval(timer.current), [])

  const start = async () => {
    const p = await api.post<PlexLinkStart>('/api/plex/link/start')
    setPin(p)
    window.open(p.url, '_blank', 'noopener')
    clearInterval(timer.current)
    timer.current = setInterval(async () => {
      const res = await api.get<PlexAccountT>(`/api/plex/link/poll?id=${p.id}`)
      if (res.linked) {
        clearInterval(timer.current)
        setPin(null)
        qc.invalidateQueries({ queryKey: ['plex-account'] })
      }
    }, 2000)
  }

  const unlink = async () => {
    await api.del('/api/plex/account')
    qc.invalidateQueries({ queryKey: ['plex-account'] })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-t-muted">
      {data?.linked ? (
        <>
          <Badge tone="ok">{t('settings.plexWatchlistLinked', { user: data.user })}</Badge>
          <Button size="sm" onClick={unlink}>
            {t('settings.plexWatchlistUnlink')}
          </Button>
        </>
      ) : pin ? (
        <span>{t('settings.plexWatchlistPending', { code: pin.code })}</span>
      ) : (
        <Button size="sm" onClick={start}>
          {t('settings.plexWatchlistLink')}
        </Button>
      )}
    </div>
  )
}

function PlexAccount() {
  const { t } = useTranslation()
  const { data } = useQuery(PLEX_ME)
  if (!data) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-t-muted">
      {data.connected ? (
        // carries a user name and a server name, so its length is the user's,
        // not the designer's - it may run over two lines on a phone
        <Badge tone="ok" multiline>
          {data.username
            ? t('settings.plexConnectedAs', { user: data.username, server: data.server })
            : t('settings.plexConnectedTo', { server: data.server })}
        </Badge>
      ) : data.configured ? (
        <span className="text-err" role="alert">
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
function TvdbAccount() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [testing, setTesting] = useState(false)
  const { data } = useQuery(TVDB_ME)
  // force=1 bypasses the backend's 24h token cache, so a changed key is
  // actually re-tested. fetchQuery writes into the same cache entry.
  const test = async () => {
    setTesting(true)
    try {
      await qc.fetchQuery({ queryKey: TVDB_ME.queryKey, queryFn: () => api.get<TvdbMe>('/api/tvdb/me?force=1'), staleTime: 0 })
    } finally {
      setTesting(false)
    }
  }
  if (!data) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-t-muted">
      {data.connected ? (
        <Badge tone="ok">{t('settings.tvdbConnected')}</Badge>
      ) : data.configured ? (
        <span className="text-err" role="alert">
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

// The model field: a dropdown of what the saved endpoint serves, with the
// stored value kept as an option when the list no longer has it; a plain
// input while no list is available (endpoint not saved yet, or failing).
function AiModelField({ value, locked, onChange }: { value: string; locked: boolean; onChange: (m: string) => void }) {
  const { t } = useTranslation()
  const { data, isFetching, refetch } = useAiModels()
  const models = data?.models ?? []
  const options = value && !models.includes(value) ? [value, ...models] : models
  return (
    <label className="text-xs text-t-muted">
      {t('settings.aiModel')}
      <EnvBadge show={locked} />
      <span className="mt-1 flex gap-2">
        {options.length > 0 ? (
          <Select className="font-mono" wrapperClassName="min-w-0 flex-1" value={value} disabled={locked} onChange={(e) => onChange(e.target.value)}>
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        ) : (
          <Input className="font-mono" placeholder="gpt-4o-mini" value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} />
        )}
        {data && (
          <Button size="sm" className="shrink-0" disabled={isFetching} onClick={() => refetch()}>
            {t('settings.aiModelsReload')}
          </Button>
        )}
      </span>
      <span className="mt-1 block">{t('settings.aiModelHint')}</span>
      {data?.error && (
        <span className="mt-1 block text-err" role="alert">
          {data.error}
        </span>
      )}
    </label>
  )
}

// Connection state of the assistant endpoint; the test button lists the
// endpoint's models, which exercises URL and key without spending tokens.
function AiAccount() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [testing, setTesting] = useState(false)
  const { data } = useQuery(AI_STATUS)
  const test = async () => {
    setTesting(true)
    try {
      await qc.fetchQuery({ queryKey: AI_STATUS.queryKey, queryFn: () => api.get<AiStatus>('/api/ai/status?force=1'), staleTime: 0 })
    } finally {
      setTesting(false)
    }
  }
  if (!data) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-t-muted">
      {data.connected ? (
        <Badge tone="ok">{t('settings.aiConnected')}</Badge>
      ) : data.error ? (
        <span className="text-err" role="alert">
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
    <div className="flex flex-wrap items-center gap-2 text-xs text-t-muted">
      {data.connected ? (
        <>
          <Badge tone="ok">{t('settings.tmdbConnectedAs', { name: data.username })}</Badge>
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
          {data.keyValid && <Badge tone="ok">{t('settings.tmdbConnected')}</Badge>}
          {data.configured && !data.keyValid && (
            <span className="text-err" role="alert">
              {data.error}
            </span>
          )}
          <Button
            size="sm"
            disabled={!data.configured}
            onClick={() => (window.location.href = '/api/tmdb/connect')}
          >
            {t('settings.tmdbConnect')}
          </Button>
          {!data.configured && <span>{t('settings.tmdbConnectHint')}</span>}
        </>
      )}
      {error && (
        <span className="text-err" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

// Linked AniList account of the current user (OAuth). Connecting redirects
// to AniList; tokens live about a year, so an expiry hint prompts re-connect.
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
  if (!data) return null
  const expires = data.expiresAt ? Date.parse(data.expiresAt.replace(' ', 'T') + 'Z') : 0
  const expiringSoon = expires > 0 && expires - Date.now() < 30 * 86_400_000
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-t-muted">
      {data.connected ? (
        <>
          <Badge tone="ok">{t('settings.anilistConnectedAs', { name: data.name })}</Badge>
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
            <span className="text-err" role="alert">
              {error}
            </span>
          )}
        </>
      ) : (
        <div className="grid w-full grid-cols-1 gap-2">
          {/* pin flow: token pasted by the user - no secret, no redirect URL.
              This is the default path; it works with the built-in client id,
              so nothing has to be configured first. */}
          <label className="text-xs text-t-muted">
            {t('settings.anilistPinLabel')}
            <span className="mt-1 flex gap-2">
              <Input
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
            </span>
            <span className="mt-1 block">
              {data.clientId ? (
                <a
                  className="text-accent underline"
                  href={`https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(data.clientId)}&response_type=token`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('settings.anilistPinGet')}
                </a>
              ) : (
                t('settings.anilistPinHint')
              )}
            </span>
          </label>
          {error && (
            <span className="text-err" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
