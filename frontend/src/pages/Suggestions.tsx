import { useState, type KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  api,
  type SuggestionItem,
  type SuggestionsResponse,
  type ProviderLinks,
  type UpgradeSuggestion,
  type UpgradeVariant,
  type UpgradeDims,
  type DismissedItem,
  type SyncPlan,
} from '../api'
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
    ['watchlist', t('suggestions.tabWatchlist')],
    ['trending', t('suggestions.tabTrending')],
    ['upgrades', t('suggestions.tabUpgrades')],
    ['incomplete', t('suggestions.tabIncomplete')],
  ] as const

  return (
    <div className="max-w-4xl">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('suggestions.title')}</h2>
          <span className="t-label mt-1">{t('suggestions.sub')}</span>
        </div>
        <button className="t-btn t-btn--sm" onClick={() => setShowIgnored((v) => !v)}>
          {t('suggestions.ignored')}
        </button>
      </header>

      {showIgnored && <IgnoredModal onClose={() => setShowIgnored(false)} />}

      <TabBar label={t('suggestions.title')} tabs={tabs.map(([key, label]) => ({ key, label }))} active={tab} onChange={setTab} />

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
  const [showCompleted, setShowCompleted] = useState(false)

  if (isLoading) return <SkeletonCards />
  const items = (data?.[bucket] ?? []) as SuggestionItem[]
  if (!items.length) return <p className="t-label">{t('suggestions.empty')}</p>

  const cards = (list: SuggestionItem[]) => (
    <ul className="grid grid-cols-1 gap-2">
      {list.map((it) => (
        <SugCard key={it.refKey} it={it} onWatch={setWatch} onSync={setSync} onNotice={setNotice} />
      ))}
    </ul>
  )

  // Watchlist: grouped by content category (Animefilme / Animeserien / Filme /
  // Serien) like the other tabs, and within each by status (Planned / Watching /
  // Completed). Items without a status fall into Planned; Completed is hidden
  // behind a global toggle and never proactively suggested.
  const statusOf = (it: SuggestionItem) => (it.status === 'CURRENT' || it.status === 'COMPLETED' ? it.status : 'PLANNING')
  const statusRows = [
    ['PLANNING', 'suggestions.statusPlanning'],
    ['CURRENT', 'suggestions.statusCurrent'],
    ['COMPLETED', 'suggestions.statusCompleted'],
  ] as const
  const completedCount = items.filter((it) => statusOf(it) === 'COMPLETED').length
  const watchlistGroups = (
    <div className="space-y-6">
      {completedCount > 0 && (
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={showCompleted} onChange={() => setShowCompleted((v) => !v)} />
          {t('suggestions.showCompleted')}
        </label>
      )}
      {CATS.map((cat) => {
        const catItems = items.filter((it) => it.category === cat)
        const visible = catItems.filter((it) => showCompleted || statusOf(it) !== 'COMPLETED')
        if (!visible.length) return null
        return (
          <div key={cat}>
            <h3 className="mb-2 font-display text-sm font-semibold tracking-wider text-t-secondary">
              {t(`suggestions.cat_${cat}`)} <span className="t-label">{visible.length}</span>
            </h3>
            <div className="space-y-3">
              {statusRows.map(([key, label]) => {
                if (key === 'COMPLETED' && !showCompleted) return null
                const list = catItems.filter((it) => statusOf(it) === key)
                if (!list.length) return null
                return (
                  <div key={key}>
                    <span className="t-label t-label--accent mb-1 block">
                      {t(label)} <span className="t-label">{list.length}</span>
                    </span>
                    {cards(list)}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="space-y-4">
      {notice && <p className="t-label t-label--accent">{notice}</p>}
      {bucket === 'watchlist'
        ? watchlistGroups
        : // trending and incomplete: grouped by content category (Animefilme /
          // Animeserien / Filme / Serien), like the rest of the suggestions
          CATS.map((cat) => {
              const list = items.filter((it) => it.category === cat)
              if (!list.length) return null
              return (
                <div key={cat}>
                  <h3 className="mb-2 font-display text-sm font-semibold tracking-wider text-t-secondary">
                    {t(`suggestions.cat_${cat}`)} <span className="t-label">{list.length}</span>
                  </h3>
                  {cards(list)}
                </div>
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
            const r = await api.post<{ queued: number }>('/api/downloads/sync', { serverId: sync.serverId, ...f })
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

  const prefill = (path: string): WatchFields => {
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
    <li className="t-panel flex flex-wrap items-start gap-4 p-3">
      {it.cover ? (
        <img src={it.cover} alt="" className="h-20 w-14 shrink-0 object-cover" />
      ) : (
        <div className="t-hatch h-20 w-14 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-sm font-medium text-t-primary">
          {it.title}
          {it.year ? <span className="text-t-muted"> ({it.year})</span> : null}
        </h4>

        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          {it.isMovie ? (
            <span className="t-label t-label--accent">{t('suggestions.movie')}</span>
          ) : it.season && it.season > 0 ? (
            <span className="t-label t-label--accent">{t('suggestions.season', { season: it.season })}</span>
          ) : null}
          <ProviderBadges providers={it.providers} links={it.links} />
          {it.status && (
            <span className={`t-label ${it.status === 'CURRENT' ? 't-label--accent' : ''}`}>{t(`suggestions.status${it.status}`)}</span>
          )}
          {it.status && it.media.episodes > 0 && <span className="text-t-muted">{t('suggestions.seen', { seen: it.progress, total: it.media.episodes })}</span>}
          {it.need ? <span className="text-t-muted">{t('suggestions.haveNeed', { have: it.have, need: it.need })}</span> : null}
          {it.media.format && <span className="t-label">{it.media.format === 'MOVIE' ? t('suggestions.movie') : t('suggestions.show')}</span>}
          {!it.status && it.media.episodes > 0 && <span className="text-t-muted">{t('suggestions.episodes', { count: it.media.episodes })}</span>}
          {it.media.averageScore > 0 && <span className="t-label t-label--accent">★ {it.media.averageScore}</span>}
        </p>

        {it.sequel && (
          <p className="mt-1 truncate text-[11px] text-t-muted">{t('suggestions.missing')}: {it.sequel.title.romaji || it.sequel.title.english}</p>
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
                  <span className="t-label mr-1">{c.serverName}</span>
                  {c.path}
                </span>
                <span className="flex gap-1.5">
                  <button className="t-btn t-btn--sm t-btn--primary" onClick={() => onWatch({ serverId: c.serverId, name: it.title, initial: prefill(c.path) })}>
                    {t('watch.add')}
                  </button>
                  <button
                    className="t-btn t-btn--sm"
                    onClick={() =>
                      it.sync?.localPath
                        ? onSync({ serverId: c.serverId, name: it.title, initial: syncFields(it.sync, it.title, c.path) })
                        : syncOnce(c.serverId, c.path)
                    }
                  >
                    {t('plex.syncOnce')}
                  </button>
                  <button className="t-btn t-btn--sm" onClick={() => navigate(`/remote?server=${c.serverId}&path=${encodeURIComponent(c.path)}`)}>
                    {t('plex.open')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* actions on every item */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {it.status && (
            <button className="t-btn t-btn--sm" title={t('suggestions.plusOneHint')} onClick={plusOne}>
              {t('suggestions.plusOne')}
            </button>
          )}
          {it.candidates.length > 0 && (
            <button className="t-btn t-btn--sm" onClick={rematch}>
              {t('suggestions.rematch')}
            </button>
          )}
          <button className="t-btn t-btn--sm" onClick={dismiss}>
            {t('suggestions.dismiss')}
          </button>
        </div>
      </div>
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
function ProviderBadges({ providers, links }: { providers: string[]; links: ProviderLinks }) {
  return (
    <>
      {providers.map((p) => {
        const url = (links as Record<string, string | undefined>)[p]
        const label = PROVIDER_LABEL[p] ?? p
        return url ? (
          <a key={p} className="t-label hover:text-accent" href={url} target="_blank" rel="noreferrer">
            {label} ↗
          </a>
        ) : (
          <span key={p} className="t-label">
            {label}
          </span>
        )
      })}
    </>
  )
}

// IgnoredModal lists ignored items (suggestions + upgrades) in an overlay and
// restores them. Backdrop click or Escape closes.
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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[10vh]"
      role="dialog"
      aria-modal="true"
      aria-label={t('suggestions.ignored')}
      onClick={onClose}
    >
      <div className="t-panel w-full max-w-lg p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-display text-sm font-semibold tracking-wider">{t('suggestions.ignored')}</h3>
          <button className="t-btn t-btn--sm" onClick={onClose} aria-label={t('common.cancel')}>
            ✕
          </button>
        </div>
        {!items.length ? (
          <p className="t-label">{t('suggestions.noIgnored')}</p>
        ) : (
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
            {items.map((d) => (
              <li key={`${d.kind}-${d.refKey}`} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  {d.label || d.refKey} <span className="t-label">{d.kind}</span>
                </span>
                <button className="t-btn t-btn--sm shrink-0" onClick={() => restore(d)}>
                  {t('suggestions.restore')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── Upgrades ──

function fmtRes(r: number): string {
  if (!r) return '?'
  if (r >= 2160) return '4K'
  return `${r}p`
}

// upgradeDiff spells out exactly what improves: resolution step and the added
// dub/sub languages, per the axes the user enabled.
function upgradeDiff(u: UpgradeSuggestion, t: (k: string, o?: Record<string, unknown>) => string): string[] {
  const out: string[] = []
  const from = u.from
  const to = u.to
  if (u.improvesRes) out.push(`${fmtRes(from.resRank)} → ${fmtRes(to.resRank)}`)
  const added = (a: string[], b: string[]) => (b ?? []).filter((x) => !(a ?? []).includes(x))
  if (u.improvesDub) out.push(`${t('suggestions.upDub')} +${added(from.dub, to.dub).join(',')}`)
  if (u.improvesSub) out.push(`${t('suggestions.upSub')} +${added(from.sub, to.sub).join(',')}`)
  return out
}

// variantQuality renders a copy's make-up: resolution and its dub/sub codes.
function variantQuality(v: UpgradeVariant): string {
  const parts = [fmtRes(v.resRank)]
  if ((v.dub ?? []).length) parts.push(`Dub ${v.dub.join(',')}`)
  if ((v.sub ?? []).length) parts.push(`Sub ${v.sub.join(',')}`)
  return parts.join(' · ')
}

// VariantBox shows one copy: where it lives (Local (Plex) when the server name
// is empty, else the server name) plus its full path, and its quality make-up.
// accent frames the recommended copy.
function VariantBox({ v, label, muted, accent }: { v: UpgradeVariant; label: string; muted?: boolean; accent?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className={`min-w-0 ${accent ? 'border border-accent p-1.5' : ''} ${muted ? 'text-t-muted' : ''}`}>
      <div className="flex items-center gap-1.5">
        <span className={`t-label shrink-0 ${accent ? 't-label--accent' : ''}`}>{label}</span>
        <span className="t-label shrink-0">{v.serverName ? v.serverName : t('suggestions.localPlex')}</span>
      </div>
      <div className="mt-0.5 break-all font-mono text-[11px]" title={v.folder}>
        {v.folder}
      </div>
      <div className="mt-0.5 text-[11px]">{variantQuality(v)}</div>
    </div>
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
  const [sync, setSync] = useState<{ serverId: number; name: string; initial: WatchFields } | null>(null)
  const [notice, setNotice] = useState('')

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
      {notice && <p className="t-label t-label--accent">{notice}</p>}
      {dims && (
        <div className="t-panel px-3 py-2.5">
          <span className="text-sm text-t-secondary">{t('suggestions.upgradeWhat')}</span>
          <div className="mt-2 flex flex-wrap gap-4">
            {(['res', 'sub', 'dub'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={dims[k]} onChange={() => toggle(k)} />
                {t(`suggestions.upgradeWhat_${k}`)}
              </label>
            ))}
          </div>
        </div>
      )}
      {isLoading ? (
        <SkeletonCards />
      ) : !items.length ? (
        <p className="t-label">{t('suggestions.noUpgrades')}</p>
      ) : (
        (() => {
          const render = (u: UpgradeSuggestion, i: number) => {
          const seasonLabel = u.isMovie ? t('suggestions.movie') : u.season > 0 ? t('suggestions.season', { season: u.season }) : ''
          const isBest = (v: UpgradeVariant) => v.serverId === u.to.serverId && v.folder === u.to.folder
          const options = u.options ?? []
          return (
            <div key={u.key || `${u.showKey}-${u.season}-${i}`} className="t-panel flex flex-wrap items-start gap-4 p-3">
              {u.cover ? (
                <img src={u.cover} alt="" className="h-20 w-14 shrink-0 object-cover" />
              ) : (
                <div className="t-hatch h-20 w-14 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                  <h4 className="min-w-0 truncate font-display text-sm font-semibold tracking-wider">{u.title}</h4>
                  <div className="flex shrink-0 flex-wrap gap-1">
                    {upgradeDiff(u, t).map((d, j) => (
                      <span key={j} className="t-label t-label--accent">
                        {d}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  {seasonLabel && <span className="t-label t-label--accent">{seasonLabel}</span>}
                  <ProviderBadges providers={u.providers ?? []} links={u.links ?? {}} />
                  {u.format && <span className="t-label">{u.format === 'MOVIE' ? t('suggestions.movie') : t('suggestions.show')}</span>}
                  {u.episodes ? <span className="text-t-muted">{t('suggestions.episodes', { count: u.episodes })}</span> : null}
                </p>
                <div className="mt-2 grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
                  <VariantBox v={u.from} label={t('suggestions.fromLabel')} muted />
                  <span className="text-center text-t-muted">→</span>
                  <VariantBox v={u.to} label={t('suggestions.recommended')} accent />
                </div>
                {options.length > 0 && (
                  <div className="mt-2">
                    <span className="t-label">{t('suggestions.allVersions')}</span>
                    <ul className="mt-1 space-y-1">
                      {options.map((o, j) => (
                        <li
                          key={`${o.serverId}-${o.folder}-${j}`}
                          className={`flex flex-col gap-0.5 border-l-2 pl-2 sm:flex-row sm:items-center sm:gap-2 ${isBest(o) ? 'border-accent' : 'border-transparent'}`}
                        >
                          <span className={`t-label shrink-0 ${isBest(o) ? 't-label--accent' : ''}`}>
                            {o.serverName ? o.serverName : t('suggestions.localPlex')}
                          </span>
                          <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-t-secondary" title={o.folder}>
                            {o.folder}
                          </span>
                          <span className="shrink-0 text-[11px] text-t-muted">{variantQuality(o)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                  {u.sync?.localPath && (
                    <button
                      className="t-btn t-btn--sm t-btn--primary"
                      onClick={() => setSync({ serverId: u.to.serverId, name: u.title, initial: syncFields(u.sync!, u.title, u.to.folder) })}
                    >
                      {t('plex.syncOnce')}
                    </button>
                  )}
                  {u.links?.plex && (
                    <a className="t-btn t-btn--sm" href={u.links.plex} target="_blank" rel="noreferrer">
                      {t('suggestions.openPlex')}
                    </a>
                  )}
                  <button className="t-btn t-btn--sm" onClick={() => dismiss(u)}>
                    {t('suggestions.dismiss')}
                  </button>
                  <button
                    className="t-btn t-btn--sm"
                    onClick={() => navigate(`/remote?server=${u.to.serverId}&path=${encodeURIComponent(u.to.folder)}`)}
                  >
                    {t('plex.openBrowser')}
                  </button>
                </div>
              </div>
            </div>
          )
          }
          return (
            <div className="space-y-4">
              {CATS.map((cat) => {
                const list = items.filter((u) => u.category === cat)
                if (!list.length) return null
                return (
                  <div key={cat}>
                    <h3 className="mb-2 font-display text-sm font-semibold tracking-wider text-t-secondary">
                      {t(`suggestions.cat_${cat}`)} <span className="t-label">{list.length}</span>
                    </h3>
                    <div className="space-y-3">{list.map(render)}</div>
                  </div>
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
          saveLabel={t('suggestions.syncOnce')}
          onSave={async (f) => {
            const r = await api.post<{ queued: number }>('/api/downloads/sync', { serverId: sync.serverId, ...f })
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
  tabs: { key: T; label: string }[]
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
    <div role="tablist" aria-label={label} className="t-tabs mb-4">
      {tabs.map((tb, i) => (
        <button
          key={tb.key}
          role="tab"
          aria-selected={active === tb.key}
          tabIndex={active === tb.key ? 0 : -1}
          className="t-tab"
          onClick={() => onChange(tb.key)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {tb.label}
        </button>
      ))}
    </div>
  )
}
