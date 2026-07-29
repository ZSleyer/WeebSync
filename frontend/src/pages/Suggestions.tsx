import { useState, type KeyboardEvent } from 'react'
import {
  Bookmark,
  CircleArrowUp,
  CircleDashed,
  Download,
  ExternalLink,
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
  Star,
  TrendingUp,
  Tv,
  X,
  type LucideIcon,
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
import { useNavigate } from 'react-router'
import {
  Badge,
  Button,
  ButtonLink,
  Checkbox,
  Cover,
  Dialog,
  Panel,
  Radio,
  SuggestionCard,
  Tab,
  Tabs,
} from '@weebsync/design-system'
import {
  api,
  type SuggestionItem,
  type SuggestionsResponse,
  type LocalSeason,
  type ProviderLinks,
  type UpgradeSuggestion,
  type UpgradeVariant,
  type UpgradeDims,
  type DismissedItem,
  type SyncPlan,
  type SyncResult,
  syncOutcome,
  mediaTitle,
} from '../api'
import Collapsible from '../components/Collapsible'
import WatchDialog, { type WatchFields } from '../components/WatchDialog'
import { usePersistedQuery } from '../hooks'
import { SkeletonCards } from '../components/Loading'

// Suggestions, tabbed by FUNCTION (not by provider): Trending, Watchlist,
// Upgrades and Incomplete. Every item is deduplicated per series and carries
// which integrations recognise it, links to each, a series-wide ignore, and a
// rematch. Data comes unified from GET /api/suggestions (+ /api/upgrades).
export default function Suggestions() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'watchlist' | 'trending' | 'upgrades' | 'incomplete'>('watchlist')
  const [showIgnored, setShowIgnored] = useState(false)
  const tabs = [
    ['watchlist', t('suggestions.tabWatchlist'), Bookmark],
    ['trending', t('suggestions.tabTrending'), TrendingUp],
    ['upgrades', t('suggestions.tabUpgrades'), CircleArrowUp],
    ['incomplete', t('suggestions.tabIncomplete'), CircleDashed],
  ] as const

  return (
    <div>
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('suggestions.title')}</h2>
          <Badge multiline className="mt-1">{t('suggestions.sub')}</Badge>
        </div>
        <Button size="sm" onClick={() => setShowIgnored((v) => !v)}>
          <EyeOff aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('suggestions.ignored')}
        </Button>
      </header>

      {showIgnored && <IgnoredModal onClose={() => setShowIgnored(false)} />}

      <TabBar label={t('suggestions.title')} tabs={tabs.map(([key, label, icon]) => ({ key, label, icon }))} active={tab} onChange={setTab} />

      {tab === 'upgrades' ? <UpgradesSection /> : <BucketSection bucket={tab} />}
    </div>
  )
}

// guessSeason reads a trailing season number from a title for the sync template.
function guessSeason(title: string): number {
  const m = title.match(/\b(?:season|s)\s*(\d{1,2})\b/i) || title.match(/\s(\d{1,2})$/)
  const n = m ? parseInt(m[1], 10) : 0
  return n >= 2 ? n : 0
}

// syncFields builds the one-off sync form from a suggestion's pre-computed
// SyncPlan (correct season/movie target + rename template) and the chosen remote
// source. Fed to WatchDialog; its dry-run preview shows the resulting path.
function syncFields(sync: SyncPlan, title: string, remotePath: string): WatchFields {
  return {
    remotePath,
    localPath: sync.localPath,
    mode: 'template',
    template: sync.template ?? '',
    separator: '',
    titleOverride: title,
    pattern: '',
    replacement: '',
    subfolder: sync.subfolder,
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
  }
}

// Content-category blocks, in reading order: Anime, then Western animation
// (Zeichentrick, non-Japanese), then live-action. Movies before series.
const CATS = ['anime-movie', 'anime-tv', 'animation-movie', 'animation-tv', 'movie', 'tv'] as const


// BucketSection renders one functional bucket. Trending and Watchlist are
// sub-grouped into the four categories (Anime series/movies, series, movies);
// Incomplete is a flat list.
function BucketSection({ bucket }: { bucket: 'trending' | 'watchlist' | 'incomplete' }) {
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
  if (!items.length) return <Badge>{t('suggestions.empty')}</Badge>

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
          <Collapsible key={key} title={t(label)} count={statusItems.length} defaultOpen={key !== 'COMPLETED'}>
            <div className="space-y-3">
              {CATS.map((cat) => {
                const list = statusItems.filter((it) => it.category === cat)
                if (!list.length) return null
                return (
                  <Collapsible key={cat} small title={t(`suggestions.cat_${cat}`)} count={list.length}>
                    {cards(list)}
                  </Collapsible>
                )
              })}
            </div>
          </Collapsible>
        )
      })}
    </div>
  )

  return (
    <div className="space-y-4">
      {notice && <Badge tone="accent">{notice}</Badge>}
      {bucket === 'watchlist'
        ? watchlistGroups
        : // trending and incomplete: grouped by content category (Animefilme /
          // Animeserien / Filme / Serien), like the rest of the suggestions
          CATS.map((cat) => {
              const list = items.filter((it) => it.category === cat)
              if (!list.length) return null
              return (
                <Collapsible key={cat} title={t(`suggestions.cat_${cat}`)} count={list.length}>
                  {cards(list)}
                </Collapsible>
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

  const prefill = (path: string): WatchFields => {
    // a missing-unit card already carries the resolved target - the season
    // folder and the template with its fixed season number. plexFolder is only
    // a basename (and empty on those cards), so it would resolve under the
    // primary download root instead of the Plex library.
    if (it.sync?.localPath) return syncFields(it.sync, it.title, path)
    const season = guessSeason(it.title)
    const movie = it.category.endsWith('movie')
    return {
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
    }
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
                  <Button size="sm" onClick={() => navigate(`/remote?server=${c.serverId}&path=${encodeURIComponent(c.path)}`)}>
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

const PROVIDER_LABEL: Record<string, string> = {
  anilist: 'AniList',
  tmdb: 'TMDB',
  tvdb: 'TVDB',
  imdb: 'IMDb',
  plex: 'Plex',
}

// ProviderBadges shows which integrations recognise the title; each links to
// that provider's page when a URL is known.
export function ProviderBadges({ providers, links }: { providers: string[]; links: ProviderLinks }) {
  return (
    <>
      {providers.map((p) => {
        const url = (links as Record<string, string | undefined>)[p]
        const label = PROVIDER_LABEL[p] ?? p
        return url ? (
          // no anchor variant of Badge in the design system, so the linked chip
          // keeps the class directly
          <a key={p} className="t-label hover:text-accent" href={url} target="_blank" rel="noreferrer">
            {label} <ExternalLink aria-hidden size="1em" className="inline align-[-0.125em]" />
          </a>
        ) : (
          <Badge key={p}>{label}</Badge>
        )
      })}
    </>
  )
}

// IgnoredModal lists ignored items (suggestions + upgrades) and restores them.
// Backdrop click or Escape closes - both come from the design system's Dialog.
function IgnoredModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = usePersistedQuery<DismissedItem[]>('dismissed', () => api.get('/api/suggestions/dismissed'))
  const items = data ?? []
  const restore = async (d: DismissedItem) => {
    await api.del('/api/suggestions/dismiss', { kind: d.kind, refKey: d.refKey })
    qc.invalidateQueries({ queryKey: ['dismissed'] })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
  }
  return (
    // the list caps itself at 60dvh, so this dialog never needs a full screen
    <Dialog onClose={onClose} width="max-w-lg" sheet={false} aria-label={t('suggestions.ignored')}>
      <div className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-display text-sm font-semibold tracking-wider">{t('suggestions.ignored')}</h3>
          <Button size="sm" onClick={onClose} aria-label={t('common.cancel')}>
            <X aria-hidden size="1.2em" />
          </Button>
        </div>
        {!items.length ? (
          <Badge>{t('suggestions.noIgnored')}</Badge>
        ) : (
          <ul className="max-h-[60dvh] space-y-1 overflow-y-auto">
            {items.map((d) => (
              <li key={`${d.kind}-${d.refKey}`} className="flex items-center justify-between gap-2 text-sm">
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
        )}
      </div>
    </Dialog>
  )
}

// ── Upgrades ──

function fmtRes(r: number): string {
  if (!r) return '?'
  if (r >= 2160) return '4K'
  return `${r}p`
}

// resTier mirrors the backend's resTier: a measured height folds onto the rung
// it belongs to, so a padded 1088 (mod-16 1080p) is not shown as beaten by the
// round 1080 a file name states. Keep the two in step.
function resTier(h: number): number {
  if (h <= 0) return 0
  if (h < 600) return 480
  if (h < 900) return 720
  if (h < 1300) return 1080
  if (h < 1800) return 1440
  if (h < 3000) return 2160
  return 4320
}

// "Und" is the backend's marker for a track whose language could not be read.
// It is a recorded hole, not a language, so it is never shown as one.
const UNREADABLE = 'Und'
const realLangs = (xs: string[]) => (xs ?? []).filter((x) => x !== UNREADABLE)

const addedLangs = (a: string[], b: string[]) => realLangs(b).filter((x) => !(a ?? []).includes(x))

// sameSource: were both copies' qualities established the same way? A measured
// copy against a name-parsed one cannot settle a language difference between
// them - the name may promise a track the container does not carry. The backend
// only lets such a gain through when the container refused to be read at all, in
// which case the gain is shown as unconfirmed.
const sameSource = (a: UpgradeVariant, b: UpgradeVariant) => a.probed === b.probed

// langGain: does v add a sub or dub language on an axis the user asked for?
const langGain = (from: UpgradeVariant, v: UpgradeVariant, dims: UpgradeDims | undefined) =>
  ((dims?.sub ?? true) && addedLangs(from.sub, v.sub).length > 0) ||
  ((dims?.dub ?? true) && addedLangs(from.dub, v.dub).length > 0)

// burnedIn: languages this copy advertises but cannot hand over as a track.
const burnedIn = (v: UpgradeVariant) => realLangs(v.sub).filter((x) => !(v.soft ?? []).includes(x))

// softGain: does v offer as a real track what the local copy only burns into
// the picture?
const softGain = (from: UpgradeVariant, v: UpgradeVariant) => addedLangs(from.soft, v.soft).length > 0

// variantDiff spells out what v would improve over the local copy on the
// user's enabled axes: resolution step and added dub/sub languages. Empty
// means this copy is no improvement.
function variantDiff(
  from: UpgradeVariant,
  v: UpgradeVariant,
  dims: UpgradeDims | undefined,
  t: (k: string, o?: Record<string, unknown>) => string,
): string[] {
  const out: string[] = []
  if ((dims?.res ?? true) && resTier(v.resRank) > resTier(from.resRank)) {
    out.push(`${fmtRes(from.resRank)} → ${fmtRes(v.resRank)}`)
  }
  if (dims?.dub ?? true) {
    const d = addedLangs(from.dub, v.dub)
    if (d.length) out.push(`${t('suggestions.upDub')} +${d.join(',')}`)
  }
  if (dims?.sub ?? true) {
    const s = addedLangs(from.sub, v.sub)
    if (s.length) out.push(`${t('suggestions.upSub')} +${s.join(',')}`)
  }
  if (dims?.soft ?? true) {
    const s = addedLangs(from.soft, v.soft)
    if (s.length) out.push(`${t('suggestions.upSoft')} ${s.join(',')}`)
  }
  return out
}

// sourceLabel names how one copy's quality was established, for the card.
function sourceLabel(v: UpgradeVariant, t: (k: string) => string): string {
  if (v.probed === 1) return t('suggestions.basisMeasured')
  if (v.probed === 2) return t('suggestions.basisUnreadable')
  return t('suggestions.basisGuessed')
}

// axesWon lists the axes on which v actually beats the local copy, by the same
// rules the backend applied. Empty when the user picked an option that is no
// improvement at all.
function axesWon(
  from: UpgradeVariant,
  v: UpgradeVariant,
  dims: UpgradeDims | undefined,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const out: string[] = []
  if ((dims?.res ?? true) && resTier(v.resRank) > resTier(from.resRank)) out.push(t('suggestions.axis_res'))
  if ((dims?.sub ?? true) && addedLangs(from.sub, v.sub).length) out.push(t('suggestions.axis_sub'))
  if ((dims?.dub ?? true) && addedLangs(from.dub, v.dub).length) out.push(t('suggestions.axis_dub'))
  if ((dims?.soft ?? true) && softGain(from, v)) out.push(t('suggestions.axis_soft'))
  return out.length ? out.join(', ') : t('suggestions.basisNoAxis')
}

// variantQuality renders a copy's make-up: resolution, its dub/sub codes, and
// which of the subtitle languages are burned into the picture rather than
// offered as a track. "Und" never appears - it marks a track whose language
// could not be read, which is a hole in the account and not a language.
function variantQuality(v: UpgradeVariant, t: (k: string) => string): string {
  const parts = [fmtRes(v.resRank)]
  const dub = realLangs(v.dub)
  const sub = realLangs(v.sub)
  const hard = burnedIn(v)
  if (dub.length) parts.push(`Dub ${dub.join(',')}`)
  if (sub.length) {
    const shown = sub.map((c) => (hard.includes(c) ? `${c} (${t('suggestions.subBurned')})` : c))
    parts.push(`Sub ${shown.join(',')}`)
  }
  return parts.join(' · ')
}

// VariantBox shows one copy: where it lives (Local (Plex) when the server name
// is empty, else the server name) plus its full path, its quality make-up, and
// how that make-up was established - measured from the file, or read off its
// name. That last line is what makes a disputed recommendation readable from
// the card instead of from the log.
function VariantBox({ v, label, muted, accent }: { v: UpgradeVariant; label: string; muted?: boolean; accent?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className={`min-w-0 ${accent ? 'border border-accent p-1.5' : ''} ${muted ? 'text-t-muted' : ''}`}>
      <div className="flex items-center gap-1.5">
        <Badge tone={accent ? 'accent' : 'neutral'} className="shrink-0">
          {label}
        </Badge>
        <Badge className="shrink-0">{v.serverName ? v.serverName : t('suggestions.localPlex')}</Badge>
      </div>
      <div className="mt-0.5 break-all font-mono text-[11px]" title={v.folder}>
        {v.folder}
      </div>
      <div className="mt-0.5 text-[11px]">{variantQuality(v, t)}</div>
      <div className="mt-0.5 text-[11px] text-t-muted">
        {t('suggestions.basisQuality', { how: sourceLabel(v, t) })}
      </div>
    </div>
  )
}

// LocalSeasons lists what the library already holds of this show, so the card
// answers "and which seasons do I have?" without a trip to Plex. The season of
// this very suggestion is marked, because that is the one a sync would touch.
// File names live in the sync dialog's preview, where they carry the
// new/replaced marks; repeating them here would only bloat the card.
function LocalSeasons({ seasons, current, isMovie }: { seasons: LocalSeason[]; current: number; isMovie?: boolean }) {
  const { t } = useTranslation()
  return (
    <Collapsible small defaultOpen={false} title={t('suggestions.localSeasons')} count={seasons.length}>
      <ul className="space-y-1">
        {seasons.map((ls) => {
          const here = !isMovie && !ls.isMovie && ls.season === current
          // a "plex:ratingKey:sN" folder means the copy is not on a mount we
          // share, so there is no path to show - only the season and quality
          const path = ls.folder.startsWith('/') ? ls.folder : ''
          return (
            <li key={`${ls.season}-${ls.folder}`} className="flex flex-wrap items-center gap-2 text-[11px]">
              <Badge tone={here ? 'accent' : 'neutral'} className="shrink-0">
                {ls.isMovie
                  ? t('suggestions.movie')
                  : ls.season === 0
                    ? t('suggestions.specials') // season 0 is what Plex calls Specials
                    : t('suggestions.season', { season: ls.season })}
              </Badge>
              <span className="min-w-0 flex-1 break-all font-mono text-t-secondary" title={path}>
                {path}
              </span>
              <span className="shrink-0 text-t-muted">{fmtRes(ls.resRank)}</span>
            </li>
          )
        })}
      </ul>
    </Collapsible>
  )
}

function UpgradesSection() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data, isLoading } = usePersistedQuery<SuggestionsResponse>(
    'suggestions',
    () => api.get('/api/suggestions'),
    { refetchInterval: (q) => (q.state.data?.building ? 4000 : false) },
  )
  const { data: dims } = usePersistedQuery<UpgradeDims>('upgrade-dims', () => api.get('/api/auth/upgrade-dims'))
  const [sync, setSync] = useState<{ serverId: number; name: string; initial: WatchFields; info: string[] } | null>(null)
  const [notice, setNotice] = useState('')
  // per-card chosen sync source among the remote copies; default = recommended
  const [choice, setChoice] = useState<Record<string, UpgradeVariant>>({})

  const toggle = async (key: keyof UpgradeDims) => {
    if (!dims) return
    await api.put('/api/auth/upgrade-dims', { ...dims, [key]: !dims[key] })
    qc.invalidateQueries({ queryKey: ['upgrade-dims'] })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
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
        <Panel className="px-3 py-2.5">
          <span className="text-sm text-t-secondary">{t('suggestions.upgradeWhat')}</span>
          <div className="mt-2 flex flex-wrap gap-4">
            {(['res', 'sub', 'dub', 'soft'] as const).map((k) => (
              <Checkbox key={k} checked={dims[k]} onChange={() => toggle(k)} label={t(`suggestions.upgradeWhat_${k}`)} />
            ))}
          </div>
        </Panel>
      )}
      {isLoading ? (
        <SkeletonCards />
      ) : !items.length ? (
        <Badge>{t('suggestions.noUpgrades')}</Badge>
      ) : (
        (() => {
          const render = (u: UpgradeSuggestion, i: number) => {
          const seasonLabel = u.isMovie ? t('suggestions.movie') : u.season > 0 ? t('suggestions.season', { season: u.season }) : ''
          const chosen: UpgradeVariant = choice[u.key] ?? u.to
          const isChosen = (v: UpgradeVariant) => v.serverId === chosen.serverId && v.folder === chosen.folder
          const options: UpgradeVariant[] = u.options ?? []
          // a language gain the two copies cannot settle between them: shown,
          // and shown as unconfirmed. Recomputed rather than read off
          // u.languageUnverified, because the user may have picked another
          // option than the recommended one.
          const langUnconfirmed = !sameSource(u.from, chosen) && langGain(u.from, chosen, dims)
          const syncInfo = [
            t('watch.infoSource', { server: chosen.serverName || t('suggestions.localPlex'), quality: variantQuality(chosen, t) }),
            t('watch.infoLocal', { quality: variantQuality(u.from, t) }),
          ]
          return (
            // handwritten instead of SuggestionCard: the heading row pairs the
            // title with the right-aligned diff chips, which the card's plain
            // <h4> slot cannot hold
            <Panel key={u.key || `${u.showKey}-${u.season}-${i}`} className="flex flex-wrap items-start gap-4 p-3">
              <Cover src={u.cover} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                  <h4 className="min-w-0 truncate font-display text-sm font-semibold tracking-wider">{u.title}</h4>
                  <div className="flex shrink-0 flex-wrap gap-1">
                    {variantDiff(u.from, chosen, dims, t).map((d, j) => (
                      <Badge key={j} tone="accent">
                        {d}
                      </Badge>
                    ))}
                    {langUnconfirmed && <Badge tone="warn">{t('suggestions.langUnverified')}</Badge>}
                  </div>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  {seasonLabel && <Badge tone="accent">{seasonLabel}</Badge>}
                  <ProviderBadges providers={u.providers ?? []} links={u.links ?? {}} />
                  {u.format && (
                    <Badge>
                      {u.format === 'MOVIE' ? <Clapperboard aria-hidden size="1em" /> : <Tv aria-hidden size="1em" />}
                      {u.format === 'MOVIE' ? t('suggestions.movie') : t('suggestions.show')}
                    </Badge>
                  )}
                  {u.episodes ? (
                    <span className="inline-flex items-center gap-1 pl-1 text-t-muted">
                      <ListVideo aria-hidden size="1em" />
                      {t('suggestions.episodes', { count: u.episodes })}
                    </span>
                  ) : null}
                  {u.library && <Badge aria-label={t('suggestions.library', { name: u.library })}>{u.library}</Badge>}
                </p>
                <div className="mt-2 grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
                  <VariantBox v={u.from} label={t('suggestions.fromLabel')} muted />
                  <span className="text-center text-t-muted">→</span>
                  <VariantBox
                    v={chosen}
                    label={isChosen(u.to) ? t('suggestions.recommended') : t('suggestions.chosenVersion')}
                    accent
                  />
                </div>
                <p className="mt-2 text-[11px] text-t-secondary">
                  {t('suggestions.basis', { axes: axesWon(u.from, chosen, dims, t) })}
                  {langUnconfirmed && ` ${t('suggestions.basisLangUnverified')}`}
                </p>
                {options.length > 0 && (
                  <fieldset className="mt-2 min-w-0 border-0 p-0">
                    <legend className="t-label">{t('suggestions.chooseVersion')}</legend>
                    <ul className="mt-1 space-y-1">
                      {options.map((o, j) => {
                        const diff = variantDiff(u.from, o, dims, t)
                        return (
                          <li
                            key={`${o.serverId}-${o.folder}-${j}`}
                            className={`border-l-2 pl-2 ${isChosen(o) ? 'border-accent' : 'border-transparent'}`}
                          >
                            <label className="flex min-h-6 cursor-pointer flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
                              <span className="flex shrink-0 items-center gap-2">
                                <Radio
                                  name={`opt-${u.key}`}
                                  checked={isChosen(o)}
                                  onChange={() => setChoice((c) => ({ ...c, [u.key]: o }))}
                                />
                                <Badge tone={isChosen(o) ? 'accent' : 'neutral'}>
                                  {o.serverName ? o.serverName : t('suggestions.localPlex')}
                                </Badge>
                              </span>
                              <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-t-secondary" title={o.folder}>
                                {o.folder}
                              </span>
                              <span className="flex shrink-0 flex-wrap items-center gap-1 text-[11px] text-t-muted">
                                {variantQuality(o, t)}
                                {diff.map((d, k) => (
                                  <Badge key={k} tone="accent">
                                    {d}
                                  </Badge>
                                ))}
                              </span>
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  </fieldset>
                )}
                {(u.localSeasons ?? []).length > 0 && (
                  <div className="mt-2">
                    <LocalSeasons seasons={u.localSeasons!} current={u.season} isMovie={u.isMovie} />
                  </div>
                )}
                <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                  {u.sync?.localPath && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        setSync({ serverId: chosen.serverId, name: u.title, initial: syncFields(u.sync!, u.title, chosen.folder), info: syncInfo })
                      }
                    >
                      <Download aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      {t('plex.syncOnce')}
                    </Button>
                  )}
                  {u.links?.plex && (
                    <ButtonLink size="sm" href={u.links.plex} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                      {t('suggestions.openPlex')}
                    </ButtonLink>
                  )}
                  <Button size="sm" onClick={() => dismiss(u)}>
                    <EyeOff aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('suggestions.dismiss')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => navigate(`/remote?server=${u.to.serverId}&path=${encodeURIComponent(u.to.folder)}`)}
                  >
                    <FolderOpen aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('plex.openBrowser')}
                  </Button>
                </div>
              </div>
            </Panel>
          )
          }
          return (
            <div className="space-y-4">
              {CATS.map((cat) => {
                const list = items.filter((u) => u.category === cat)
                if (!list.length) return null
                return (
                  <Collapsible key={cat} title={t(`suggestions.cat_${cat}`)} count={list.length}>
                    <div className="space-y-3">{list.map(render)}</div>
                  </Collapsible>
                )
              })}
            </div>
          )
        })()
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

// ── tab bar (ARIA tabs: underline, roving tabindex, arrow keys) ──
function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: { key: T; label: string; icon?: LucideIcon }[]
  active: T
  onChange: (k: T) => void
  label: string
}) {
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    const next = (idx + dir + tabs.length) % tabs.length
    onChange(tabs[next].key)
    const els = e.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]')
    els?.[next]?.focus()
  }
  return (
    <Tabs aria-label={label} className="mb-4">
      {tabs.map((tb, i) => (
        <Tab
          key={tb.key}
          selected={active === tb.key}
          tabIndex={active === tb.key ? 0 : -1}
          onClick={() => onChange(tb.key)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {tb.icon && <tb.icon aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />}
          {tb.label}
        </Tab>
      ))}
    </Tabs>
  )
}
