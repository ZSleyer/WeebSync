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

      {showIgnored && <IgnoredPanel />}

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

const CATS = ['anime-tv', 'anime-movie', 'tv', 'movie'] as const

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
  const [notice, setNotice] = useState('')

  if (isLoading) return <SkeletonCards />
  const items = (data?.[bucket] ?? []) as SuggestionItem[]
  if (!items.length) return <p className="t-label">{t('suggestions.empty')}</p>

  const cards = (list: SuggestionItem[]) => (
    <ul className="grid grid-cols-1 gap-2">
      {list.map((it) => (
        <SugCard key={it.refKey} it={it} onWatch={setWatch} onNotice={setNotice} />
      ))}
    </ul>
  )

  return (
    <div className="space-y-4">
      {notice && <p className="t-label t-label--accent">{notice}</p>}
      {bucket === 'incomplete'
        ? cards(items)
        : CATS.map((cat) => {
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
    </div>
  )
}

// SugCard: cover, title, provider badges (linking to each integration), the
// category- and status-specific info, and the actions available everywhere -
// watch, sync, open, ignore, rematch (+ AniList +1 for watchlist entries).
function SugCard({
  it,
  onWatch,
  onNotice,
}: {
  it: SuggestionItem
  onWatch: (w: { serverId: number; name: string; initial: WatchFields }) => void
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
          <ProviderBadges providers={it.providers} links={it.links} />
          {it.status && (
            <span className={`t-label ${it.status === 'CURRENT' ? 't-label--accent' : ''}`}>{t(`suggestions.status${it.status}`)}</span>
          )}
          {it.status && it.media.episodes > 0 && <span className="text-t-muted">{t('suggestions.seen', { seen: it.progress, total: it.media.episodes })}</span>}
          {it.need ? <span className="text-t-muted">{t('suggestions.haveNeed', { have: it.have, need: it.need })}</span> : null}
          {it.media.averageScore > 0 && <span className="t-label t-label--accent">★ {it.media.averageScore}</span>}
        </p>

        {it.sequel && (
          <p className="mt-1 truncate text-[11px] text-t-muted">{t('suggestions.missing')}: {it.sequel.title.romaji || it.sequel.title.english}</p>
        )}
        {it.plexFolder && (
          <p className="mt-1 truncate font-mono text-[11px] text-t-muted" title={it.plexFolder}>
            {t('suggestions.plexFolder')}: {it.plexFolder}
          </p>
        )}

        {/* per-candidate sync/watch/open */}
        {it.candidates.length > 0 && (
          <ul className="mt-2 space-y-1">
            {it.candidates.map((c) => (
              <li key={`${c.serverId}-${c.path}`} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-t-secondary" title={c.path}>
                  {c.path.replace(/\/+$/, '').split('/').pop()} <span className="t-label">{c.serverName}</span>
                </span>
                <span className="flex gap-1.5">
                  <button className="t-btn t-btn--sm t-btn--primary" onClick={() => onWatch({ serverId: c.serverId, name: it.title, initial: prefill(c.path) })}>
                    {t('watch.add')}
                  </button>
                  <button className="t-btn t-btn--sm" onClick={() => syncOnce(c.serverId, c.path)}>
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

// IgnoredPanel lists ignored items (suggestions + upgrades) and restores them.
function IgnoredPanel() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = usePersistedQuery<DismissedItem[]>('dismissed', () => api.get('/api/suggestions/dismissed'))
  const items = data ?? []
  const restore = async (d: DismissedItem) => {
    await api.del('/api/suggestions/dismiss', { kind: d.kind, refKey: d.refKey })
    qc.invalidateQueries({ queryKey: ['dismissed'] })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
    qc.invalidateQueries({ queryKey: ['upgrades'] })
  }
  return (
    <div className="mb-4 border border-border-subtle bg-bg-secondary/20 p-3">
      <h3 className="mb-2 font-display text-sm font-semibold tracking-wider">{t('suggestions.ignored')}</h3>
      {!items.length ? (
        <p className="t-label">{t('suggestions.noIgnored')}</p>
      ) : (
        <ul className="space-y-1">
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

function VariantBox({ v, muted }: { v: UpgradeVariant; muted?: boolean }) {
  const parts = [fmtRes(v.resRank)]
  if ((v.dub ?? []).length) parts.push(`Dub ${v.dub.join(',')}`)
  if ((v.sub ?? []).length) parts.push(`Sub ${v.sub.join(',')}`)
  return (
    <div className={`min-w-0 ${muted ? 'text-t-muted' : ''}`}>
      <div className="truncate font-mono text-xs">{v.folder.split('/').pop()}</div>
      <div className="mt-0.5 text-[11px]">{parts.join(' · ')}</div>
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

  const toggle = async (key: keyof UpgradeDims) => {
    if (!dims) return
    await api.put('/api/auth/upgrade-dims', { ...dims, [key]: !dims[key] })
    qc.invalidateQueries({ queryKey: ['upgrade-dims'] })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
  }
  const dismiss = async (u: UpgradeSuggestion) => {
    await api.post('/api/suggestions/dismiss', { kind: 'upgrade', refKey: `series:${u.seriesId}`, label: u.title })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
    qc.invalidateQueries({ queryKey: ['dismissed'] })
  }

  const items = data?.upgrades ?? []
  return (
    <div className="space-y-3">
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
        items.map((u, i) => (
          <div key={`${u.seriesId}-${i}`} className="t-panel p-3">
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="truncate font-display text-sm font-semibold tracking-wider">{u.title}</h4>
              <div className="flex shrink-0 flex-wrap gap-1">
                {upgradeDiff(u, t).map((d, j) => (
                  <span key={j} className="t-label t-label--accent">
                    {d}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-2 grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
              <VariantBox v={u.from} muted />
              <span className="text-center text-t-muted">→</span>
              <VariantBox v={u.to} />
            </div>
            <div className="mt-2 flex justify-end gap-2">
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
        ))
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
