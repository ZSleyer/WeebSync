import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Input, Panel, Select } from '@weebsync/design-system'
import { api, type PlexAccount as PlexAccountT, type PlexLinkStart } from '../../api'
import { EnvBadge, SaveBar, useSettingsForm, type SettingsState } from './useSettingsForm'
import { UnsavedGuard } from '../../hooks/useUnsavedGuard'

export default function Integrations() {
  const { t } = useTranslation()
  const { form, set, save, saved, locked, dirty } = useSettingsForm()
  if (!form) return null

  return (
    <>
      <UnsavedGuard dirty={dirty} />
      <Panel as="section" className="mb-4 p-5" aria-label={t('settings.integrations')}>
        <Badge tone="accent">{t('settings.integrations')}</Badge>
        <div className="mt-3 grid grid-cols-1 gap-4">
          <Badge>AniList</Badge>
          <AnilistAccount />
          <AnilistOwnApp form={form} set={set} locked={locked} />
        </div>
        <label className="mt-3 block text-xs text-t-muted">
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
        <div className="mt-3">
          <TmdbAccount />
        </div>
        <label className="mt-3 block text-xs text-t-muted">
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
        <div className="mt-3">
          <TvdbAccount />
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4">
          <Badge>{t('settings.plex')}</Badge>
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
          <PlexAccount />
          <PlexWatchlistAccount />
          {form.plexTokenSet && form.plexUrl && (
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
              <div className="text-xs text-t-muted">
                {t('settings.plexRoots')}
                <textarea
                  className="t-input mt-1 font-mono"
                  rows={3}
                  placeholder={'/media/anime => /mnt/disk1/anime\n/media/serien => /mnt/disk2/serien'}
                  value={form.plexRoots}
                  onChange={(e) => set('plexRoots', e.target.value)}
                />
                <span className="mt-1 block">{t('settings.plexRootsHint')}</span>
              </div>
            </>
          )}
        </div>
      </Panel>
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
    <fieldset className="text-xs text-t-muted">
      <legend>{t('settings.plexSections')}</legend>
      <ul className="mt-1 grid grid-cols-1 gap-1.5">
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
    </fieldset>
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
  const { data } = useQuery<{ configured: boolean }>({
    queryKey: ['anilist-me'],
    queryFn: () => api.get('/api/anilist/me'),
  })
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
        <div className="mt-2 grid grid-cols-1 gap-3 border border-border-subtle bg-bg-secondary/40 p-2">
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
  const { data } = useQuery<{
    configured: boolean
    connected: boolean
    username?: string
    server?: string
    error?: string
  }>({
    queryKey: ['plex-me'],
    queryFn: () => api.get('/api/plex/me'),
  })
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
  const { data } = useQuery<{ configured: boolean; connected: boolean; error?: string }>({
    queryKey: ['tvdb-me'],
    queryFn: () => api.get('/api/tvdb/me'),
  })
  // force=1 bypasses the backend's 24h token cache, so a changed key is
  // actually re-tested. fetchQuery writes into the same cache entry.
  const test = async () => {
    setTesting(true)
    try {
      await qc.fetchQuery({ queryKey: ['tvdb-me'], queryFn: () => api.get('/api/tvdb/me?force=1'), staleTime: 0 })
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

// Linked TMDB account of the current user (v3 request-token flow). The
// watchlist suggestions need it; trending works with the API key alone.
function TmdbAccount() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const { data } = useQuery<{
    configured: boolean
    keyValid: boolean
    connected: boolean
    username?: string
    error?: string
  }>({
    queryKey: ['tmdb-me'],
    queryFn: () => api.get('/api/tmdb/me'),
  })
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
  const { data } = useQuery<{ configured: boolean; clientId?: string; connected: boolean; name?: string; expiresAt?: string }>({
    queryKey: ['anilist-me'],
    queryFn: () => api.get('/api/anilist/me'),
  })
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
