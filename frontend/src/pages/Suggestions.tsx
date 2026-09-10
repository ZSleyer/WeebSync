import { useState } from 'react'
import {
  Bookmark,
  Bot,
  ChevronDown,
  ChevronUp,
  CircleArrowUp,
  CircleDashed,
  Copy,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  ListVideo,
  Plus,
  RefreshCw,
  RotateCcw,
  CalendarClock,
  Check,
  Clapperboard,
  Pause,
  Play,
  Server,
  Sparkles,
  Star,
  TrendingUp,
  Tv,
  X,
  type LucideIcon,
  Trash2,
} from 'lucide-react'

// icon per AniList watch status, shown inside the t-label chips
const WATCH_STATUS_ICON: Record<string, LucideIcon> = {
  PLANNING: CalendarClock,
  CURRENT: Play,
  COMPLETED: Check,
  PAUSED: Pause,
  DROPPED: X,
  REPEATING: RefreshCw,
}
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '../components/confirm'
import { Navigate, Outlet, useNavigate, useSearchParams } from 'react-router'
import {
  Badge,
  Button,
  Checkbox,
  Cover,
  Dialog,
  Disclosure,
  IconButton,
  Panel,
  SuggestionCard,
  useMediaQuery,
} from '@weebsync/design-system'
import {
  api,
  type SuggestionItem,
  type SuggestionsResponse,
  type UpgradeSuggestion,
  type UpgradeVariant,
  type UpgradeDims,
  type DismissedItem,
  type DuplicateItem,
  type SyncResult,
  syncOutcome,
  mediaTitle,
  fmtBytes,
} from '../api'
import MediaDetail from '../components/MediaDetail'
import { ProviderBadges } from '../components/ProviderBadges'
import UpgradeCard, { type SyncRequest } from '../components/UpgradeCard'
import { fmtEpisodeRanges, guessSeason, syncFields, variantQuality } from '../components/upgradeQuality'
import WatchDialog, { type WatchFields } from '../components/WatchDialog'
import { applyDefaults, suggestionKind, useWatchDefaults } from '../components/watchDefaults'
import { useAiStatus, usePersistedQuery, useAuth } from '../hooks'
import { WIDE_MQ } from '../components/PageActions'
import { SectionHub, SectionNav, type SectionGroup } from '../components/SectionNav'
import { SkeletonCards } from '../components/Loading'

// Suggestions, tabbed by FUNCTION (not by provider): Trending, Watchlist,
// Upgrades and Incomplete. Every item is deduplicated per series and carries
// which integrations recognise it, links to each, a series-wide ignore, and a
// rematch. Data comes unified from GET /api/suggestions (+ /api/upgrades).
const BUCKETS = ['watchlist', 'recommended', 'trending', 'upgrades', 'incomplete', 'duplicates', 'ignored'] as const
type Bucket = (typeof BUCKETS)[number]

// The sections in their groups, with the count each shows in the menu. The
// blob is the same query every section reads, so the menu costs no request.
function useGroups(): SectionGroup[] {
  const { data } = usePersistedQuery<SuggestionsResponse>('suggestions', () => api.get('/api/suggestions'))
  const { data: dismissed } = usePersistedQuery<DismissedItem[]>('dismissed', () => api.get('/api/suggestions/dismissed'))
  const { data: ai } = useAiStatus()
  const n = (k: Exclude<Bucket, 'ignored'>) => (data && !data.building ? (data[k]?.length ?? 0) : undefined)
  const item = (to: Bucket | 'assistant', key: string, icon: LucideIcon, count?: number) => ({ to, key, icon, hint: `suggestions.hub.${to}`, count })
  return [
    // the assistant leads: it is what the section opens on, and it is optional
    // - without a configured endpoint its entry stays out of the menu (the
    // page itself explains when opened directly)
    ...(ai?.configured ? [{ label: 'suggestions.groupAssistant', items: [item('assistant', 'nav.assistant', Bot)] }] : []),
    {
      label: 'suggestions.groupDiscover',
      items: [
        item('watchlist', 'suggestions.tabWatchlist', Bookmark, n('watchlist')),
        item('recommended', 'suggestions.tabRecommended', Sparkles, n('recommended')),
        item('trending', 'suggestions.tabTrending', TrendingUp, n('trending')),
      ],
    },
    {
      label: 'suggestions.groupLibrary',
      items: [
        item('upgrades', 'suggestions.tabUpgrades', CircleArrowUp, n('upgrades')),
        item('incomplete', 'suggestions.tabIncomplete', CircleDashed, n('incomplete')),
        item('duplicates', 'suggestions.tabDuplicates', Copy, n('duplicates')),
      ],
    },
    { label: 'suggestions.groupHidden', items: [item('ignored', 'suggestions.ignored', EyeOff, dismissed?.length)] },
  ]
}

// The frame around the sections: heading and side menu on desktop, just the
// section on a phone (the app bar carries its title and the way back).
export default function SuggestionsLayout() {
  const { t } = useTranslation()
  const groups = useGroups()
  const { data } = usePersistedQuery<SuggestionsResponse>('suggestions', () => api.get('/api/suggestions'))
  // the wrappers are flex columns down to the section, so a section that
  // fills the screen by design (the assistant's log and composer) can claim
  // the remaining height; a list section is unaffected
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="mb-6 hidden lg:block">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('suggestions.title')}</h2>
        <Badge multiline className="mt-1">{t('suggestions.sub')}</Badge>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
        <SectionNav label={t('suggestions.navLabel')} groups={groups} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* the blob is assembled in the background every half hour; while it
              is, the counts in the menu are missing and a bucket may be short */}
          {data?.building && (
            <Badge multiline role="status" className="mb-4 self-start">
              <RefreshCw aria-hidden size="1em" className="animate-spin motion-reduce:animate-none" />
              {t('suggestions.building')}
            </Badge>
          )}
          <Outlet />
        </div>
      </div>
    </div>
  )
}

// The index: the phone's menu of sections. Desktop has the side menu, so it
// opens the first section instead. `?tab=` is the old single-page address
// and still lands on its section.
export function SuggestionsHub() {
  const groups = useGroups()
  const wide = useMediaQuery(WIDE_MQ)
  const { data: ai, isPending: aiPending } = useAiStatus()
  const [params] = useSearchParams()
  const tab = params.get('tab') as Bucket | null
  if (tab && BUCKETS.includes(tab)) return <Navigate to={`/suggestions/${tab}`} replace />
  // A desktop opens on the assistant where one is configured: asking is the
  // shorter way to the same lists, and the menu beside it stays in view the
  // whole time. On a phone this list IS the menu, so it opens first - the
  // assistant is its top entry, one tap away, and skipping past it would put
  // the sections behind the back gesture.
  if (wide) {
    if (aiPending) return null // no flash of the watchlist before the answer is in
    return <Navigate to={ai?.configured ? '/suggestions/assistant' : '/suggestions/watchlist'} replace />
  }
  return <SectionHub groups={groups} />
}

// Content-category blocks, in reading order: Anime, then Western animation
// (Zeichentrick, non-Japanese), then live-action. Movies before series.
const CATS = ['anime-movie', 'anime-tv', 'animation-movie', 'animation-tv', 'movie', 'tv'] as const


// BucketSection renders one functional bucket. Trending and Watchlist are
// sub-grouped into the four categories (Anime series/movies, series, movies);
// Incomplete is a flat list.
export function BucketSection({ bucket }: { bucket: 'trending' | 'watchlist' | 'recommended' | 'incomplete' }) {
  const { t } = useTranslation()
  const { data, isLoading } = usePersistedQuery<SuggestionsResponse>(
    'suggestions',
    () => api.get('/api/suggestions'),
    { refetchInterval: (q) => (q.state.data?.building ? 4000 : false) },
  )
  const [watch, setWatch] = useState<{ serverId: number; name: string; initial: WatchFields } | null>(null)
  const [sync, setSync] = useState<{ serverId: number; name: string; initial: WatchFields } | null>(null)
  const [notice, setNotice] = useState('')

  if (isLoading) return <SkeletonCards />
  const items = (data?.[bucket] ?? []) as SuggestionItem[]
  if (!items.length && data?.building) return <SkeletonCards />
  if (!items.length) return <Badge multiline>{t(bucket === 'recommended' ? 'suggestions.emptyRecommended' : 'suggestions.empty')}</Badge>

  const cards = (list: SuggestionItem[]) => (
    <ul className="grid grid-cols-1 gap-2">
      {list.map((it) => (
        <SugCard key={it.refKey} it={it} onWatch={setWatch} onSync={setSync} onNotice={setNotice} />
      ))}
    </ul>
  )

  // Watchlist: grouped by status (Planned / Watching / Completed, in that
  // order), each status collapsible with the content categories (Animefilme /
  // Animeserien / Filme / Serien) as collapsible sub-groups. Items without a
  // status fall into Planned; Completed starts collapsed and is never
  // proactively suggested.
  const statusOf = (it: SuggestionItem) => (it.status === 'CURRENT' || it.status === 'COMPLETED' ? it.status : 'PLANNING')
  const statusRows = [
    ['PLANNING', 'suggestions.statusPlanning'],
    ['CURRENT', 'suggestions.statusCurrent'],
    ['COMPLETED', 'suggestions.statusCompleted'],
  ] as const
  const watchlistGroups = (
    <div className="space-y-6">
      {statusRows.map(([key, label]) => {
        const statusItems = items.filter((it) => statusOf(it) === key)
        if (!statusItems.length) return null
        return (
          <Disclosure key={key} title={t(label)} count={statusItems.length} defaultOpen={key !== 'COMPLETED'}>
            <div className="space-y-3">
              {CATS.map((cat) => {
                const list = statusItems.filter((it) => it.category === cat)
                if (!list.length) return null
                return (
                  <Disclosure key={cat} small title={t(`suggestions.cat_${cat}`)} count={list.length}>
                    {cards(list)}
                  </Disclosure>
                )
              })}
            </div>
          </Disclosure>
        )
      })}
    </div>
  )

  // Incomplete: episode gaps inside seasons you own are one finding, missing
  // seasons and sequels another; each group has the content categories as
  // collapsible sub-groups, so a flood of films never buries a missing episode
  const incompleteRows = [
    ['episodes', 'suggestions.groupEpisodes', (it: SuggestionItem) => it.kind === 'episodes'],
    ['seasons', 'suggestions.groupSeasons', (it: SuggestionItem) => it.kind !== 'episodes'],
  ] as const
  const incompleteGroups = (
    <div className="space-y-6">
      {incompleteRows.map(([key, label, pick]) => {
        const groupItems = items.filter(pick)
        if (!groupItems.length) return null
        return (
          <Disclosure key={key} title={t(label)} count={groupItems.length}>
            <div className="space-y-3">
              {CATS.map((cat) => {
                const list = groupItems.filter((it) => it.category === cat)
                if (!list.length) return null
                return (
                  <Disclosure key={cat} small title={t(`suggestions.cat_${cat}`)} count={list.length}>
                    {cards(list)}
                  </Disclosure>
                )
              })}
            </div>
          </Disclosure>
        )
      })}
    </div>
  )

  return (
    <div className="space-y-4">
      {notice && <Badge tone="accent">{notice}</Badge>}
      {bucket === 'watchlist'
        ? watchlistGroups
        : bucket === 'incomplete'
          ? incompleteGroups
          : // trending and recommended: grouped by content category (Animefilme /
            // Animeserien / Filme / Serien), like the rest of the suggestions
            CATS.map((cat) => {
              const list = items.filter((it) => it.category === cat)
              if (!list.length) return null
              return (
                <Disclosure key={cat} title={t(`suggestions.cat_${cat}`)} count={list.length}>
                  {cards(list)}
                </Disclosure>
              )
            })}
      {watch && (
        <WatchDialog
          title={watch.name}
          serverId={watch.serverId}
          initial={watch.initial}
          onSave={async (f) => {
            await api.post('/api/watches', { serverId: watch.serverId, ...f })
            setNotice(t('watch.saved'))
          }}
          onClose={() => setWatch(null)}
        />
      )}
      {sync && (
        <WatchDialog
          title={sync.name}
          serverId={sync.serverId}
          initial={sync.initial}
          saveLabel={t('suggestions.syncOnce')}
          onSave={async (f) => {
            const r = await api.post<SyncResult>('/api/downloads/sync', { serverId: sync.serverId, ...f })
            // nothing queued: hand the reason back so the dialog stays open and
            // shows it, instead of closing onto a notice far above the fold
            const why = syncOutcome(r, t)
            if (why) return why
            setNotice(t('remote.queued', { count: r.queued }))
          }}
          onClose={() => setSync(null)}
        />
      )}
    </div>
  )
}

// SugCard: cover, title, provider badges (linking to each integration), the
// category- and status-specific info, and the actions available everywhere -
// watch, sync, open, ignore, rematch (+ AniList +1 for watchlist entries).
function SugCard({
  it,
  onWatch,
  onSync,
  onNotice,
}: {
  it: SuggestionItem
  onWatch: (w: { serverId: number; name: string; initial: WatchFields }) => void
  onSync: (w: { serverId: number; name: string; initial: WatchFields }) => void
  onNotice: (s: string) => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const StatusIcon = it.status ? WATCH_STATUS_ICON[it.status] : undefined

  const { data: defaults } = useWatchDefaults()
  const prefill = (path: string): WatchFields => {
    // a missing-unit card already carries the resolved target - the season
    // folder and the template with its fixed season number. plexFolder is only
    // a basename (and empty on those cards), so it would resolve under the
    // primary download root instead of the Plex library. The user's defaults
    // fill whatever is still blank after that.
    const kind = suggestionKind(it.category)
    if (it.sync?.localPath) return applyDefaults(syncFields(it.sync, it.title, path), kind, defaults)
    const season = guessSeason(it.title)
    const movie = it.category.endsWith('movie')
    return applyDefaults({
      remotePath: path,
      localPath: it.plexFolder ?? '',
      mode: 'template',
      template: movie
        ? ''
        : season > 0
          ? `{title} - S${String(season).padStart(2, '0')}E{episode:02}`
          : '{title} - S{season:02}E{episode:02}',
      separator: '',
      titleOverride: it.title,
      pattern: '',
      replacement: '',
      subfolder: false,
      mediaId: 0,
      mediaSource: 'anilist',
      fromEpisode: 0,
      airedMapping: false,
      renameProvider: '',
      renameOrdering: '',
      renameTitleLang: '',
      renameSeriesId: 0,
      wantDub: '',
      wantSub: '',
      plexAudioLang: '',
      plexSubLang: '',
    }, kind, defaults)
  }

  const syncOnce = async (serverId: number, path: string) => {
    try {
      const r = await api.post<{ queued: number }>('/api/downloads', { serverId, remotePath: path, localPath: it.plexFolder ?? '' })
      onNotice(t('remote.queued', { count: r.queued }))
    } catch (e) {
      onNotice(e instanceof Error ? e.message : t('app.error'))
    }
  }

  const dismiss = async () => {
    await api.post('/api/suggestions/dismiss', { kind: 'suggestion', refKey: it.refKey, label: it.title })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
    qc.invalidateQueries({ queryKey: ['dismissed'] })
  }

  const rematch = async () => {
    if (!it.candidates.length) return
    let n = 0
    for (const c of it.candidates) {
      try {
        await api.post(`/api/servers/${c.serverId}/catalog/rematch`, { path: c.path, all: true })
        n++
      } catch {
        /* keep going */
      }
    }
    onNotice(t('suggestions.rematchQueued', { count: n }))
  }

  const plusOne = async () => {
    try {
      await api.post('/api/anilist/progress', { mediaId: it.media.id, progress: (it.progress ?? 0) + 1 })
      qc.invalidateQueries({ queryKey: ['suggestions'] })
    } catch (e) {
      onNotice(e instanceof Error ? e.message : t('app.error'))
    }
  }

  return (
    <li>
      <SuggestionCard
        cover={it.cover}
        title={it.title}
        year={it.year}
        badges={
          <>
            {it.isMovie ? (
              <Badge tone="accent">{t('suggestions.movie')}</Badge>
            ) : it.season && it.season > 0 ? (
              <Badge tone="accent">{t('suggestions.season', { season: it.season })}</Badge>
            ) : null}
            <ProviderBadges providers={it.providers} links={it.links} />
            {it.status && (
              <Badge tone={it.status === 'CURRENT' ? 'accent' : 'neutral'}>
                {StatusIcon && <StatusIcon aria-hidden size="1em" />}
                {t(`suggestions.status${it.status}`)}
              </Badge>
            )}
            {it.status && it.media.episodes > 0 && (
              <span className="inline-flex items-center gap-1 pl-1 text-t-muted">
                <Eye aria-hidden size="1em" />
                {t('suggestions.seen', { seen: it.progress ?? 0, total: it.media.episodes })}
              </span>
            )}
            {it.need ? (
              <span className="inline-flex items-center gap-1 pl-1 text-t-muted">
                <ListVideo aria-hidden size="1em" />
                {t('suggestions.haveNeed', { have: it.have, need: it.need })}
              </span>
            ) : null}
            {it.missing?.length ? (
              <Badge tone="warn" multiline aria-label={t('suggestions.missingEpisodes', { list: fmtEpisodeRanges(it.missing) })}>
                {t('suggestions.missingEpisodes', { list: fmtEpisodeRanges(it.missing) })}
              </Badge>
            ) : null}
            {it.media.format && (
              <Badge>
                {it.media.format === 'MOVIE' ? <Clapperboard aria-hidden size="1em" /> : <Tv aria-hidden size="1em" />}
                {it.media.format === 'MOVIE' ? t('suggestions.movie') : t('suggestions.show')}
              </Badge>
            )}
            {!it.status && it.media.episodes > 0 && (
              <span className="inline-flex items-center gap-1 pl-1 text-t-muted">
                <ListVideo aria-hidden size="1em" />
                {t('suggestions.episodes', { count: it.media.episodes })}
              </span>
            )}
            {it.media.averageScore > 0 && (
              <Badge tone="accent">
                <Star aria-hidden size="1em" className="mr-0.5 inline align-[-0.125em]" fill="currentColor" strokeWidth={0} />
                {it.media.averageScore}
              </Badge>
            )}
            {it.library && <Badge aria-label={t('suggestions.library', { name: it.library })}>{it.library}</Badge>}
          </>
        }
        actionsPlacement="inline"
        actions={
          <>
            {it.status && (
              <Button size="sm" title={t('suggestions.plusOneHint')} onClick={plusOne}>
                <Plus aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('suggestions.plusOne')}
              </Button>
            )}
            {it.candidates.length > 0 && (
              <Button size="sm" onClick={rematch}>
                <RefreshCw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('suggestions.rematch')}
              </Button>
            )}
            <Button size="sm" onClick={dismiss}>
              <EyeOff aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
              {t('suggestions.dismiss')}
            </Button>
          </>
        }
      >
        {/* two differently styled detail lines plus the candidate list - more
            than the card's single `detail` slot, so they ride along as children */}
        {!!it.because?.length && (
          <p className="mt-1 text-[11px] text-t-muted">
            {t('suggestions.because', { titles: it.because.join(', ') })}
          </p>
        )}
        {it.why && <p className="mt-1 text-[11px] text-t-secondary">{it.why}</p>}
        {it.sequel && (
          <p className="mt-1 truncate text-[11px] text-t-muted">{t('suggestions.missing')}: {mediaTitle(it.sequel)}</p>
        )}
        {it.plexFolder && (
          <p className="mt-1 break-all font-mono text-[11px] text-t-muted" title={it.plexFolder}>
            {t('suggestions.localPath')}: {it.plexFolder}
          </p>
        )}

        {/* per-candidate sync/watch/open */}
        {it.candidates.length > 0 && (
          <ul className="mt-2 space-y-1">
            {it.candidates.map((c) => (
              <li key={`${c.serverId}-${c.path}`} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-t-secondary" title={c.path}>
                  <Badge className="mr-1">
                    <Server aria-hidden size="1em" />
                    {c.serverName}
                  </Badge>
                  {c.path}
                </span>
                <span className="flex gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => onWatch({ serverId: c.serverId, name: it.title, initial: prefill(c.path) })}>
                    <Eye aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('watch.add')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      it.sync?.localPath
                        ? onSync({ serverId: c.serverId, name: it.title, initial: syncFields(it.sync, it.title, c.path) })
                        : syncOnce(c.serverId, c.path)
                    }
                  >
                    <Download aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('plex.syncOnce')}
                  </Button>
                  <Button size="sm" onClick={() => navigate(`/files?server=${c.serverId}&path=${encodeURIComponent(c.path)}`)}>
                    <FolderOpen aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('plex.open')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SuggestionCard>
    </li>
  )
}

// The ignored bucket lists dismissed suggestions, upgrades and duplicates and
// restores them. A bucket like the others, not a modal: on a phone a modal
// over the list was one more layer to close.
export function IgnoredSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = usePersistedQuery<DismissedItem[]>('dismissed', () => api.get('/api/suggestions/dismissed'))
  const items = data ?? []
  const restore = async (d: DismissedItem) => {
    await api.del('/api/suggestions/dismiss', { kind: d.kind, refKey: d.refKey })
    qc.invalidateQueries({ queryKey: ['dismissed'] })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
  }
  if (!items.length) return <Badge>{t('suggestions.noIgnored')}</Badge>
  return (
    <ul className="space-y-1">
      {items.map((d) => (
        <li key={`${d.kind}-${d.refKey}`} className="flex items-center justify-between gap-2 border-b border-border-subtle/50 py-1 text-sm">
          <span className="min-w-0 truncate">
            {d.label || d.refKey} <Badge>{d.kind}</Badge>
          </span>
          <Button size="sm" className="shrink-0" onClick={() => restore(d)}>
            <RotateCcw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('suggestions.restore')}
          </Button>
        </li>
      ))}
    </ul>
  )
}

// ── Upgrades ──

export function UpgradesSection() {
  const { t } = useTranslation()
  const { data: defaults } = useWatchDefaults()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data, isLoading } = usePersistedQuery<SuggestionsResponse>(
    'suggestions',
    () => api.get('/api/suggestions'),
    { refetchInterval: (q) => (q.state.data?.building ? 4000 : false) },
  )
  const { data: dims } = usePersistedQuery<UpgradeDims>('upgrade-dims', () => api.get('/api/auth/upgrade-dims'))
  const [sync, setSync] = useState<SyncRequest | null>(null)
  const [notice, setNotice] = useState('')
  const [detail, setDetail] = useState<UpgradeSuggestion | null>(null)
  // per-card chosen sync source among the remote copies; default = recommended
  const [choice, setChoice] = useState<Record<string, UpgradeVariant>>({})

  // the axes in the user's priority order, disabled ones after them so a row
  // can be switched on without losing its place; every change is saved whole
  const AXES = ['res', 'soft', 'sub', 'dub'] as const
  type Axis = (typeof AXES)[number]
  const order: Axis[] = dims
    ? [...(dims.order ?? []).filter((a): a is Axis => (AXES as readonly string[]).includes(a)), ...AXES.filter((a) => !(dims.order ?? []).includes(a))]
    : [...AXES]
  const saveDims = async (next: UpgradeDims) => {
    await api.put('/api/auth/upgrade-dims', next)
    qc.invalidateQueries({ queryKey: ['upgrade-dims'] })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
  }
  const toggle = (key: Axis) => {
    if (!dims) return
    const on = !dims[key]
    void saveDims({ ...dims, [key]: on, order: order.filter((a) => (a === key ? on : dims[a])) })
  }
  const move = (key: Axis, dir: -1 | 1) => {
    if (!dims) return
    const i = order.indexOf(key)
    const j = i + dir
    if (i < 0 || j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[i], next[j]] = [next[j], next[i]]
    void saveDims({ ...dims, order: next.filter((a) => dims[a]) })
  }
  const dismiss = async (u: UpgradeSuggestion) => {
    await api.post('/api/suggestions/dismiss', { kind: 'upgrade', refKey: u.key, label: u.title })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
    qc.invalidateQueries({ queryKey: ['dismissed'] })
  }

  const items = data?.upgrades ?? []
  return (
    <div className="space-y-3">
      {notice && <Badge tone="accent">{notice}</Badge>}
      {dims && (
        <Disclosure small defaultOpen={false} title={t('suggestions.upgradeWhat')} count={order.filter((a) => dims[a]).length}>
          <Panel className="px-3 py-2.5">
            <p className="text-xs text-t-muted">{t('suggestions.upgradeOrderHint')}</p>
            <ol className="mt-2 space-y-1">
            {order.map((k, i) => (
              <li key={k} className={`flex items-center gap-2 ${dims[k] ? '' : 'text-t-muted'}`}>
                <span className="w-5 shrink-0 font-mono text-xs text-t-muted" aria-hidden>
                  {dims[k] ? `${i + 1}.` : ''}
                </span>
                <Checkbox checked={dims[k]} onChange={() => toggle(k)} label={t(`suggestions.upgradeWhat_${k}`)} />
                <span className="ml-auto flex gap-1">
                  <IconButton aria-label={t('suggestions.moveUp', { axis: t(`suggestions.upgradeWhat_${k}`) })} disabled={!dims[k] || i === 0} onClick={() => move(k, -1)}>
                    <ChevronUp aria-hidden size="1em" />
                  </IconButton>
                  <IconButton
                    aria-label={t('suggestions.moveDown', { axis: t(`suggestions.upgradeWhat_${k}`) })}
                    disabled={!dims[k] || i === order.length - 1 || !dims[order[i + 1]]}
                    onClick={() => move(k, 1)}
                  >
                    <ChevronDown aria-hidden size="1em" />
                  </IconButton>
                </span>
              </li>
            ))}
            </ol>
          </Panel>
        </Disclosure>
      )}
      {isLoading ? (
        <SkeletonCards />
      ) : !items.length ? (
        <Badge>{t('suggestions.noUpgrades')}</Badge>
      ) : (
        (() => {
          const render = (u: UpgradeSuggestion, i: number) => (
            <UpgradeCard
              key={u.key || `${u.showKey}-${u.season}-${i}`}
              u={u}
              dims={dims}
              chosen={choice[u.key] ?? u.to}
              onChoose={(o) => setChoice((c) => ({ ...c, [u.key]: o }))}
              onSync={(r) => setSync({ ...r, initial: applyDefaults(r.initial, 'anime-series', defaults) })}
              onDismiss={dismiss}
              onOpenRemote={(v) => navigate(`/files?server=${v.serverId}&path=${encodeURIComponent(v.folder)}`)}
              onDetails={setDetail}
            />
          )
          return (
            <div className="space-y-4">
              {CATS.map((cat) => {
                const list = items.filter((u) => u.category === cat)
                if (!list.length) return null
                return (
                  <Disclosure key={cat} title={t(`suggestions.cat_${cat}`)} count={list.length}>
                    <div className="space-y-3">{list.map(render)}</div>
                  </Disclosure>
                )
              })}
            </div>
          )
        })()
      )}
      {detail?.media && (
        <Dialog width="max-w-3xl" aria-label={t('remote.detailsFor', { name: detail.title })} onClose={() => setDetail(null)}>
          <MediaDetail media={detail.media} source={detail.providers?.includes('tmdb') ? 'tmdb:tv' : 'anilist'} />
        </Dialog>
      )}
      {sync && (
        <WatchDialog
          title={sync.name}
          serverId={sync.serverId}
          initial={sync.initial}
          info={sync.info}
          saveLabel={t('suggestions.syncOnce')}
          onSave={async (f) => {
            const r = await api.post<SyncResult>('/api/downloads/sync', { serverId: sync.serverId, ...f })
            // nothing queued: hand the reason back so the dialog stays open and
            // shows it, instead of closing onto a notice far above the fold
            const why = syncOutcome(r, t)
            if (why) return why
            setNotice(t('remote.queued', { count: r.queued }))
          }}
          onClose={() => setSync(null)}
        />
      )}
    </div>
  )
}

// ── Duplicates ──

// DuplicatesSection lists what the library holds twice. It only shows; which
// copy goes is decided in Plex or on disk, the card just marks the one the
// quality order would keep.
export function DuplicatesSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: user } = useAuth()
  const [notice, setNotice] = useState('')
  const { data, isLoading } = usePersistedQuery<SuggestionsResponse>(
    'suggestions',
    () => api.get('/api/suggestions'),
    { refetchInterval: (q) => (q.state.data?.building ? 4000 : false) },
  )
  const dismiss = async (d: DuplicateItem) => {
    await api.post('/api/suggestions/dismiss', { kind: 'duplicate', refKey: d.refKey, label: d.title })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
    qc.invalidateQueries({ queryKey: ['dismissed'] })
  }
  // one copy (a folder, or one file of a doubled episode) goes to the trash
  // folder beside it; the server rebuilds the suggestions afterwards
  const trash = async (path: string) => {
    const name = path.split('/').filter(Boolean).pop() ?? path
    const ok = await confirm({ message: t('suggestions.dupTrashConfirm', { name }), confirmLabel: t('suggestions.dupTrash'), destructive: true })
    if (!ok) return
    try {
      await api.post('/api/suggestions/duplicates/trash', { path })
      setNotice(t('suggestions.dupTrashed', { name }))
      qc.invalidateQueries({ queryKey: ['suggestions'] })
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }
  const trashButton = (path: string) =>
    user?.isAdmin ? (
      <Button size="sm" onClick={() => trash(path)}>
        <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
        {t('suggestions.dupTrash')}
      </Button>
    ) : null
  if (isLoading) return <SkeletonCards />
  const items = data?.duplicates ?? []
  if (!items.length) return <Badge multiline>{t('suggestions.noDuplicates')}</Badge>
  const card = (d: DuplicateItem) => {
    const seasonLabel = d.isMovie ? t('suggestions.movie') : d.season > 0 ? t('suggestions.season', { season: d.season }) : ''
    return (
      <Panel key={d.refKey} className="flex flex-wrap items-start gap-4 p-3">
        <Cover src={d.cover} />
        <div className="min-w-0 flex-1">
          <h4 className="min-w-0 wrap-break-word font-display text-sm font-semibold tracking-wider">{d.title}</h4>
          {d.why && <p className="mt-1 text-[11px] text-t-secondary">{d.why}</p>}
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            {seasonLabel && <Badge tone="accent">{seasonLabel}</Badge>}
            {d.library && <Badge aria-label={t('suggestions.library', { name: d.library })}>{d.library}</Badge>}
            {d.episodes?.length ? (
              <Badge tone="warn" multiline>
                {t('suggestions.dupEpisodes', { list: fmtEpisodeRanges(d.episodes) })}
              </Badge>
            ) : (
              <Badge tone="warn">{t('suggestions.dupCopies', { count: d.copies.length })}</Badge>
            )}
          </p>
          <ul className="mt-2 space-y-1">
            {d.copies.map((c) => (
              <li key={c.folder} className={`rounded-lg border p-2 text-xs ${c.folder === d.keep ? 'border-accent' : 'border-border-subtle'}`}>
                <div className="flex flex-wrap items-center gap-1.5">
                  {c.folder === d.keep && d.copies.length > 1 && <Badge tone="accent">{t('suggestions.dupKeep')}</Badge>}
                  <span className="text-t-muted">
                    {variantQuality(c, t)} · {t('suggestions.dupFiles', { count: c.files })} · {fmtBytes(c.bytes)}
                  </span>
                </div>
                <div className="mt-1 break-all font-mono text-t-secondary" title={c.folder}>
                  {c.folder}
                </div>
                {d.copies.length > 1 && c.folder !== d.keep && <div className="mt-1.5 flex justify-end">{trashButton(c.folder)}</div>}
              </li>
            ))}
          </ul>
          {d.twice?.length ? (
            <ul className="mt-2 space-y-1">
              {d.twice.map((e) => (
                <li key={e.episode} className="rounded-lg border border-border-subtle p-2 text-xs">
                  <Badge tone="warn">{t('suggestions.dupEpisode', { n: e.episode })}</Badge>
                  <ul className="mt-1 space-y-1">
                    {e.files.map((f) => (
                      <li key={f.path} className="flex flex-wrap items-center justify-between gap-1.5">
                        <span className="min-w-0 break-all font-mono text-t-secondary" title={f.path}>
                          {f.path.split('/').pop()} <span className="text-t-muted">· {fmtBytes(f.bytes)}</span>
                        </span>
                        {trashButton(f.path)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-2 flex flex-wrap justify-end gap-1.5">
            <Button size="sm" onClick={() => dismiss(d)}>
              <EyeOff aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
              {t('suggestions.dismiss')}
            </Button>
          </div>
        </div>
      </Panel>
    )
  }
  return (
    <div className="space-y-4">
      {notice && (
        <Badge tone="accent" multiline role="status">
          {notice}
        </Badge>
      )}
      {user?.isAdmin && <p className="text-xs text-t-muted">{t('suggestions.dupTrashHint')}</p>}
      {CATS.map((cat) => {
        const list = items.filter((d) => d.category === cat)
        if (!list.length) return null
        return (
          <Disclosure key={cat} title={t(`suggestions.cat_${cat}`)} count={list.length}>
            <div className="space-y-3">{list.map(card)}</div>
          </Disclosure>
        )
      })}
    </div>
  )
}

// ── tab bar (ARIA tabs: underline, roving tabindex, arrow keys) ──
