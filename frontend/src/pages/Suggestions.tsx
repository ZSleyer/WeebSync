import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Button, Checkbox, IconButton, Rows, TextLink } from 'fluid-lycoris'
import { useToast, useFailToast } from '../components/toast'
import {
  api,
  type SuggestionItem,
  type SuggestionsResponse,
  type TrashEntry,
  type UpgradeSuggestion,
  type UpgradeVariant,
  type UpgradeDims,
  type DismissedItem,
  type SyncResult,
  suggestionSource,
  syncOutcome,
  mediaTitle,
  fmtBytes,
} from '../api'
import { SeriesCardView, useSeriesModal } from '../components/SeriesModal'
import UpgradeCard, { type SyncRequest } from '../components/UpgradeCard'
import { fmtEpisodeRanges, guessSeason, syncFields } from '../components/upgradeQuality'
import WatchDialog, { WatchForm, type WatchFields } from '../components/WatchDialog'
import { applyDefaults, suggestionKind, useWatchDefaults } from '../components/watchDefaults'
import ActionMenu from '../components/ActionMenu'
import { CatalogTile, useTileRise } from '../components/CatalogTile'
import { useAiStatus, useNow, usePersistedQuery, useAuth, useWholeSave } from '../hooks'
import { sectionOf, slugOf, type DiscoverSection } from '../discoverRoutes'
import { SectionOutlet } from '../components/RouteTransition'
import { coverSet } from '../images'
import { ANILIST_SETTINGS, useAnilistMe } from '../anilistMe'
import {
  DiscoverGroup,
  DiscoverHead,
  DiscoverNav,
  EmptyNote,
  LoadFailed,
  SkeletonRows,
  SugRow,
  useDismiss,
  useLateRise,
  type DiscoverNavGroup,
} from './DiscoverParts'
import { asOfLine, copyLine, listOf, metaLine, progressLine, shortPath } from './discoverText'
import { LAYOUT, useCounts, useDismissed, useSuggestions, type ListSection } from './discoverGroups'
import './discover.css'

// Entdecken: the suggestion lists by what they are for (Merkliste,
// Empfohlen, Trending), what the library lacks or holds twice (Upgrades,
// Unvollständig, Duplikate), and the questions (Assistent, Ausgeblendet).
// One blob from GET /api/suggestions feeds every list. Each section has its
// own address under /discover (discoverRoutes.ts).
// the head of each list section: title and the quiet line under it
const HEADS: Record<Exclude<DiscoverSection, 'assistant'>, string> = {
  watchlist: 'suggestions.tabWatchlist',
  recommended: 'suggestions.tabRecommended',
  trending: 'suggestions.tabTrending',
  upgrades: 'suggestions.tabUpgrades',
  incomplete: 'suggestions.tabIncomplete',
  duplicates: 'suggestions.tabDuplicates',
  ignored: 'suggestions.ignored',
}

/**
 * The frame: the sections menu (a sticky strip on a phone, a column on a
 * desktop) and the open section with its head. /discover itself is the
 * overview (DiscoverHub); on a phone it stands in for the strip.
 */
export default function SuggestionsLayout() {
  const { t } = useTranslation()
  const { data: ai } = useAiStatus()
  const { data } = useSuggestions()
  const counts = useCounts()
  const { pathname } = useLocation()
  const section = sectionOf(pathname.split('/')[2])
  const groups: DiscoverNavGroup[] = [
    { label: '', items: [{ id: 'hub', to: '', label: t('discover.hub') }] },
    ...LAYOUT.map((g) => ({
      label: t(g.label),
      items: g.items
        .filter(([id]) => id !== 'assistant' || ai?.configured || section === 'assistant')
        .map(([id, key]) => ({ id, to: slugOf(id), label: t(key), count: counts[id] })),
    })),
  ]
  const onList = section && section !== 'assistant'
  return (
    <div className="dc" data-hub={section ? undefined : ''}>
      <DiscoverNav label={t('discover.navLabel')} groups={groups} current={section} />
      <div className="dc-body">
        {onList && (
          <DiscoverHead title={t(HEADS[section])} sub={t(`discover.sub.${section}`, { count: counts[section] ?? 0 })} />
        )}
        {/* the blob is assembled in the background every half hour; while it
            is, a list may be short or empty */}
        {onList && section !== 'ignored' && data?.building && (
          <p className="dc-building" role="status">
            <RefreshCw aria-hidden size="1em" className="animate-spin motion-reduce:animate-none" />
            {t('suggestions.building')}
          </p>
        )}
        <SectionOutlet />
      </div>
    </div>
  )
}

/**
 * /discover: what Entdecken holds at a glance, by group. Each section is a
 * card with its count, what it is for and the first covers in it, so the
 * page says where to look instead of dropping the user into one list. An
 * old ?tab= address still opens its section.
 */
export function DiscoverHub() {
  const { t, i18n } = useTranslation()
  const [params] = useSearchParams()
  const { data: ai } = useAiStatus()
  const { data } = useSuggestions()
  const { data: dismissed } = useDismissed()
  const counts = useCounts()
  const tab = sectionOf(params.get('tab'))
  if (tab) return <Navigate replace to={slugOf(tab)} />
  const covers = (id: DiscoverSection): string[] => {
    const list: { cover?: string }[] =
      id === 'ignored' ? (dismissed ?? []) : id === 'assistant' ? [] : (data?.[id] ?? [])
    return list.flatMap((x) => (x.cover ? [x.cover] : [])).slice(0, 4)
  }
  return (
    <div className="dc-hub">
      <DiscoverHead title={t('discover.hub')} sub={t('discover.hubSub')} />
      {LAYOUT.map((g) => {
        const items = g.items.filter(([id]) => id !== 'assistant' || ai?.configured)
        if (!items.length) return null
        return (
          <section key={g.label} aria-label={t(g.label)}>
            <h3 className="dc-hub-g">{t(g.label)}</h3>
            <ul className="dc-hub-grid">
              {items.map(([id, key, Icon]) => {
                const peek = covers(id)
                return (
                  <li key={id}>
                    <Link to={slugOf(id)} className="dc-hub-card">
                      <span className="dc-hub-icon">
                        <Icon aria-hidden size={20} />
                      </span>
                      <span className="dc-hub-text">
                        <strong>{t(key)}</strong>
                        <span>{t(`suggestions.hub.${id}`)}</span>
                      </span>
                      {counts[id] != null && (
                        <span className="dc-hub-count">{counts[id]!.toLocaleString(i18n.language)}</span>
                      )}
                      {peek.length > 0 && (
                        <span className="dc-hub-peek" aria-hidden>
                          {peek.map((src) => (
                            <img key={src} src={src} alt="" loading="lazy" decoding="async" />
                          ))}
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

type WatchReq = { serverId: number; name: string; initial: WatchFields; inCard?: boolean }

/** The sync form a suggestion starts from: its own plan when it has one, else a template by kind. */
function usePrefill() {
  const { data: defaults } = useWatchDefaults()
  return (it: SuggestionItem, path: string): WatchFields => {
    // a missing-unit row carries the resolved target (season folder, template
    // with its season); plexFolder is only a basename and empty on those
    const kind = suggestionKind(it.category)
    if (it.sync?.localPath) return applyDefaults(syncFields(it.sync, it.title, path), kind, defaults)
    const season = guessSeason(it.title)
    const movie = it.category.endsWith('movie')
    return applyDefaults(
      {
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
      },
      kind,
      defaults,
    )
  }
}

/**
 * A list section: Merkliste in its status groups, Empfohlen flat, Trending
 * as a cover grid, Unvollständig split into missing episodes and missing
 * seasons. No grouping by category: the category is in each row's meta line.
 */
export function BucketSection({ bucket }: { bucket: 'trending' | 'watchlist' | 'recommended' | 'incomplete' }) {
  const { t } = useTranslation()
  const { data, isLoading, isError, refetch } = useSuggestions()
  const [watch, setWatch] = useState<WatchReq | null>(null)
  const [sync, setSync] = useState<WatchReq | null>(null)
  const toast = useToast()
  const qc = useQueryClient()
  const prefill = usePrefill()
  const { open: openSeries } = useSeriesModal()
  const list = useRef<HTMLDivElement>(null)
  const items = (data?.[bucket] ?? []) as SuggestionItem[]
  const waiting = isLoading || (!items.length && !!data?.building)
  useLateRise(list, !waiting)
  const grid = useRef<HTMLDivElement>(null)
  useTileRise(grid, bucket === 'trending' && !waiting)
  // +1 writes to AniList, which the user has to allow first: until then the
  // progress stays read-only and one line says where to allow it
  const { data: me } = useAnilistMe()
  const stepOff = !!me?.connected && !me.allow?.list && items.some((it) => it.status)

  // the series card, with "Auto-Sync anlegen" when a server holds it
  const open = (it: SuggestionItem) =>
    openSeries({
      source: suggestionSource(it),
      id: it.media.id,
      media: it.media,
      title: it.title,
      actions: it.candidates[0]
        ? [
            {
              key: 'watch',
              label: t('series.action.setupWatch'),
              primary: true,
              onClick: () =>
                setWatch({
                  serverId: it.candidates[0].serverId,
                  name: it.title,
                  initial: prefill(it, it.candidates[0].path),
                  inCard: true,
                }),
            },
          ]
        : [],
    })

  let body
  if (waiting) body = bucket === 'trending' ? <SkeletonRows n={4} /> : <SkeletonRows />
  else if (isError && !data) body = <LoadFailed onRetry={() => void refetch()} />
  else if (!items.length)
    body =
      bucket === 'recommended' ? (
        <EmptyNote title={t('suggestions.empty')} sub={t('suggestions.emptyRecommended')} />
      ) : (
        <EmptyNote title={t('suggestions.empty')} />
      )
  else if (bucket === 'trending')
    body = (
      <div ref={grid} className="ws-cat-grid dc-wide">
        {items.map((it, i) => (
          <div key={it.refKey} className="ws-cat-cell">
            <CatalogTile
              media={it.media}
              name={it.title}
              sub={t(`discover.cat.${it.category}`, { defaultValue: '' })}
              onOpen={() => open(it)}
              eager={i < 6}
              priority={i === 0}
            />
          </div>
        ))}
      </div>
    )
  else {
    const rows = (l: SuggestionItem[]) => (
      <Rows>
        {l.map((it, i) => (
          <SugItemRow
            key={it.refKey}
            it={it}
            section={bucket}
            eager={i < 8}
            onOpen={() => open(it)}
            onWatch={(c) => setWatch({ serverId: c.serverId, name: it.title, initial: prefill(it, c.path) })}
            onSync={(c) => setSync({ serverId: c.serverId, name: it.title, initial: prefill(it, c.path) })}
          />
        ))}
      </Rows>
    )
    if (bucket === 'watchlist') {
      // Läuft, Geplant (paused, dropped and repeating with it), Fertig closed
      const statusOf = (it: SuggestionItem) =>
        it.status === 'CURRENT' || it.status === 'COMPLETED' ? it.status : 'PLANNING'
      body = (
        <>
          {(
            [
              ['CURRENT', 'discover.status.current', true],
              ['PLANNING', 'discover.status.planning', true],
              ['COMPLETED', 'discover.status.completed', false],
            ] as const
          ).map(([key, label, isOpen]) => {
            const l = items.filter((it) => statusOf(it) === key)
            return l.length ? (
              <DiscoverGroup key={key} title={t(label)} count={l.length} open={isOpen}>
                {rows(l)}
              </DiscoverGroup>
            ) : null
          })}
        </>
      )
    } else if (bucket === 'incomplete') {
      body = (
        <>
          {(
            [
              ['episodes', 'suggestions.groupEpisodes', (it: SuggestionItem) => it.kind === 'episodes'],
              ['seasons', 'suggestions.groupSeasons', (it: SuggestionItem) => it.kind !== 'episodes'],
            ] as const
          ).map(([key, label, pick]) => {
            const l = items.filter(pick)
            return l.length ? (
              <DiscoverGroup key={key} title={t(label)} count={l.length}>
                {rows(l)}
              </DiscoverGroup>
            ) : null
          })}
        </>
      )
    } else body = rows(items)
  }

  return (
    <div ref={list}>
      {stepOff && !waiting && (
        <p className="sg-stepoff">
          {t('suggestions.plusOneOff')}{' '}
          <Link className="t-link t-link--2" to={ANILIST_SETTINGS}>
            {t('suggestions.plusOneAllow')}
          </Link>
        </p>
      )}
      {isError && data && <LoadFailed stale onRetry={() => void refetch()} />}
      {body}
      {watch &&
        (watch.inCard ? (
          <SeriesCardView title={watch.name} onClose={() => setWatch(null)}>
            {(v) => (
              <WatchForm
                {...v}
                title={watch.name}
                serverId={watch.serverId}
                initial={watch.initial}
                onSave={async (f) => {
                  await api.post('/api/watches', { serverId: watch.serverId, ...f })
                  await qc.invalidateQueries({ queryKey: ['watches'] })
                  toast({ message: t('discover.watchCreated', { name: watch.name }) })
                }}
                onClose={() => setWatch(null)}
              />
            )}
          </SeriesCardView>
        ) : (
          <WatchDialog
            title={watch.name}
            serverId={watch.serverId}
            initial={watch.initial}
            onSave={async (f) => {
              await api.post('/api/watches', { serverId: watch.serverId, ...f })
              qc.invalidateQueries({ queryKey: ['watches'] })
              toast({ message: t('discover.watchCreated', { name: watch.name }) })
            }}
            onClose={() => setWatch(null)}
          />
        ))}
      {sync && (
        <WatchDialog
          title={sync.name}
          serverId={sync.serverId}
          initial={sync.initial}
          saveLabel={t('suggestions.syncOnce')}
          onSave={async (f) => {
            const r = await api.post<SyncResult>('/api/downloads/sync', { serverId: sync.serverId, ...f })
            // nothing queued: the reason goes back into the open dialog
            const why = syncOutcome(r, t)
            if (why) return why
            qc.invalidateQueries({ queryKey: ['downloads'] })
            toast({ message: t('discover.queued', { name: sync.name, count: r.queued }) })
          }}
          onClose={() => setSync(null)}
        />
      )}
    </div>
  )
}

type Cand = SuggestionItem['candidates'][number]

/**
 * One suggestion of a list: the meta line, the progress or the reason, the
 * first server copy (the others behind "und N weitere"), and the actions.
 * +1, rematch and the file browser sit in the row's menu.
 */
function SugItemRow({
  it,
  section,
  eager,
  onOpen,
  onWatch,
  onSync,
}: {
  it: SuggestionItem
  section: ListSection
  eager?: boolean
  onOpen: () => void
  onWatch: (c: Cand) => void
  onSync: (c: Cand) => void
}) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useFailToast()
  const hide = useDismiss()
  const [more, setMore] = useState(false)
  const c0 = it.candidates[0]

  // a one-off copy straight into the queue when the suggestion has no plan
  // of its own; with one the dialog shows where it lands first
  const once = async (c: Cand) => {
    if (it.sync?.localPath) return onSync(c)
    try {
      const r = await api.post<{ queued: number }>('/api/downloads', {
        serverId: c.serverId,
        remotePath: c.path,
        localPath: it.plexFolder ?? '',
      })
      qc.invalidateQueries({ queryKey: ['downloads'] })
      toast({ message: t('discover.queued', { name: it.title, count: r.queued }) })
    } catch (e) {
      fail(e)
    }
  }

  const rematch = async () => {
    let n = 0
    for (const c of it.candidates) {
      try {
        await api.post(`/api/servers/${c.serverId}/catalog/rematch`, { path: c.path, all: true })
        n++
      } catch {
        /* keep going */
      }
    }
    toast({ message: t('suggestions.rematchQueued', { count: n }) })
  }

  // one step at a time: a second +1 before the first answer would send the same count
  const [stepping, setStepping] = useState(false)
  // only offered once the user allowed WeebSync to change the list
  const canStep = !!useAnilistMe().data?.allow?.list
  const plusOne = async () => {
    if (stepping) return
    setStepping(true)
    const progress = (it.progress ?? 0) + 1
    try {
      await api.post('/api/anilist/progress', { mediaId: it.media.id, progress })
      const bump = (l: SuggestionsResponse['watchlist']) =>
        l.map((x) => (x.media.id === it.media.id && x.status ? { ...x, progress } : x))
      qc.setQueryData<SuggestionsResponse>(['suggestions'], (d) =>
        d
          ? {
              ...d,
              watchlist: bump(d.watchlist),
              recommended: bump(d.recommended),
              trending: bump(d.trending),
              incomplete: bump(d.incomplete),
            }
          : d,
      )
      qc.invalidateQueries({ queryKey: ['suggestions'] })
    } catch (e) {
      fail(e)
    } finally {
      setStepping(false)
    }
  }

  const menu = [
    ...(it.status && canStep ? [{ key: 'plus', label: t('suggestions.plusOne'), onClick: () => void plusOne() }] : []),
    ...(c0 ? [{ key: 'rematch', label: t('suggestions.rematch'), onClick: () => void rematch() }] : []),
    ...(c0
      ? [
          {
            key: 'open',
            label: t('plex.openBrowser'),
            onClick: () => navigate(`/files?server=${c0.serverId}&path=${encodeURIComponent(c0.path)}`),
          },
        ]
      : []),
  ]

  const season = it.isMovie
    ? undefined
    : it.season && it.season > 0
      ? t('suggestions.season', { season: it.season })
      : undefined
  const because = it.because ?? []
  const [pre, post = ''] = t('discover.because', { titles: '\u0001' }).split('\u0001')
  const target = it.kind && it.sync?.localPath ? it.sync.localPath : it.plexFolder
  return (
    <SugRow
      title={it.title}
      season={season}
      meta={metaLine(
        {
          year: it.year,
          category: it.category,
          episodes: it.isMovie ? 0 : it.media.episodes,
          score: it.media.averageScore,
          library: it.library,
        },
        t,
      )}
      cover={coverSet(it.media.coverImage) ?? (it.cover ? { src: it.cover } : undefined)}
      coverTint={it.media.coverImage?.color}
      onOpen={it.media ? onOpen : undefined}
      openLabel={t('remote.detailsFor', { name: it.title })}
      eager={eager}
    >
      {it.status && it.status !== 'PLANNING' && (it.progress ?? 0) > 0 && (
        <span className="sg-prog">{progressLine(it.progress ?? 0, it.media.episodes, t)}</span>
      )}
      {because.length > 0 && (
        <span className="sg-why">
          {pre}
          {(() => {
            try {
              return new Intl.ListFormat(i18n.language, { type: 'conjunction' })
                .formatToParts(because)
                .map((p, k) => (p.type === 'element' ? <b key={k}>{p.value}</b> : p.value))
            } catch {
              return listOf(because, i18n.language)
            }
          })()}
          {post}
        </span>
      )}
      {it.why && <span className="sg-why">{it.why}</span>}
      {it.missing?.length ? (
        <span className="sg-why sg-warn">
          {t('suggestions.missingEpisodes', { list: fmtEpisodeRanges(it.missing) })}
        </span>
      ) : null}
      {it.sequel && (
        <span className="sg-why">
          {t('suggestions.missing')}: {mediaTitle(it.sequel)}
        </span>
      )}
      {c0 ? (
        <span className="sg-cand">
          {t('discover.onServer')} <span className="mono">{shortPath(c0.path)}</span>
          {it.candidates.length > 1 && (
            <>
              {' '}
              <button type="button" className="sg-more" aria-expanded={more} onClick={() => setMore(!more)}>
                {t('discover.moreCands', { count: it.candidates.length - 1 })}
              </button>
            </>
          )}
        </span>
      ) : (
        <span className="sg-cand none">{t('discover.noCand')}</span>
      )}
      {more && (
        <ul className="sg-cands">
          {it.candidates.map((c) => (
            <li key={`${c.serverId}-${c.path}`}>
              <span className="mono" title={c.path}>
                {c.path}
              </span>
              <span>{c.serverName}</span>
              <TextLink onClick={() => onWatch(c)}>{t('discover.autoSync')}</TextLink>
              <TextLink onClick={() => void once(c)}>{t('discover.once')}</TextLink>
              <TextLink
                tone="accent-2"
                onClick={() => navigate(`/files?server=${c.serverId}&path=${encodeURIComponent(c.path)}`)}
              >
                {t('plex.openBrowser')}
              </TextLink>
            </li>
          ))}
        </ul>
      )}
      {section === 'incomplete' && target && (
        <span className="sg-cand">
          {t('discover.target')} <span className="mono">{target}</span>
        </span>
      )}
      <span className="sg-acts">
        {c0 && (
          <>
            <Button size="sm" variant="primary" onClick={() => onWatch(c0)}>
              {t('discover.autoSync')}
            </Button>
            <Button size="sm" onClick={() => void once(c0)}>
              {t('discover.once')}
            </Button>
          </>
        )}
        <TextLink
          onClick={(e) =>
            void hide(
              { kind: 'suggestion', refKey: it.refKey, label: it.title, cover: it.cover, section },
              e.currentTarget,
            )
          }
        >
          {t('suggestions.dismiss')}
        </TextLink>
        {menu.length > 0 && (
          <span className="sg-end">
            <ActionMenu label={t('discover.more')} title={it.title} actions={menu} />
          </span>
        )}
      </span>
    </SugRow>
  )
}

/** What a hidden item came from, by the section it was hidden in, else by its kind. */
function sectionLabel(d: DismissedItem, t: (k: string) => string): string {
  const s = sectionOf(d.section)
  if (s && s !== 'assistant' && s !== 'ignored') return t(HEADS[s])
  return t(`suggestions.ignoredKind_${d.kind}`)
}

/** Ausgeblendet: what was hidden, with its cover and the list it came from, and the way back. */
export function IgnoredSection() {
  const fail = useFailToast()
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, isError, refetch } = useDismissed()
  const list = useRef<HTMLDivElement>(null)
  useLateRise(list, !isLoading)
  const items = data ?? []
  const restore = async (d: DismissedItem) => {
    try {
      await api.del('/api/suggestions/dismiss', { kind: d.kind, refKey: d.refKey })
      qc.invalidateQueries({ queryKey: ['dismissed'] })
      qc.invalidateQueries({ queryKey: ['suggestions'] })
    } catch (e) {
      fail(e)
    }
  }
  return (
    <div ref={list}>
      {isError && data && <LoadFailed stale onRetry={() => void refetch()} />}
      {isLoading ? (
        <SkeletonRows n={4} />
      ) : isError && !data ? (
        <LoadFailed onRetry={() => void refetch()} />
      ) : !items.length ? (
        <EmptyNote title={t('discover.empty.ignored')} />
      ) : (
        <Rows>
          {items.map((d) => (
            <li key={`${d.kind}-${d.refKey}`} className="t-row">
              <div className="t-row-in">
                {d.cover && (
                  <span className="sg-cov" aria-hidden>
                    <img src={d.cover} alt="" loading="lazy" className="size-full object-cover" />
                  </span>
                )}
                <span className="t-row-t">
                  <strong>{d.label || d.refKey}</strong>
                  <span>{sectionLabel(d, t)}</span>
                </span>
                <Button size="sm" className="shrink-0" onClick={() => restore(d)}>
                  {t('suggestions.restore')}
                </Button>
              </div>
            </li>
          ))}
        </Rows>
      )}
    </div>
  )
}

// ── Upgrades ──

const AXES = ['res', 'soft', 'sub', 'dub'] as const
type Axis = (typeof AXES)[number]

/** What counts as an upgrade: the axes in their order, each on or off, moved up and down. */
function UpgradeAxes() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: dims } = usePersistedQuery<UpgradeDims>('upgrade-dims', () => api.get('/api/auth/upgrade-dims'))
  // each change applies to the latest dims, so a second click before the
  // first save returns builds on it instead of undoing it
  const saveDims = useWholeSave<UpgradeDims>(
    'upgrade-dims',
    (next) => api.put('/api/auth/upgrade-dims', next),
    () => qc.invalidateQueries({ queryKey: ['suggestions'] }),
  )
  const orderOf = (d: UpgradeDims): Axis[] => [
    ...(d.order ?? []).filter((a): a is Axis => (AXES as readonly string[]).includes(a)),
    ...AXES.filter((a) => !(d.order ?? []).includes(a)),
  ]
  // the disabled axes sink below the enabled ones, so a row switched back on keeps its place
  const toggle = (key: Axis) =>
    saveDims((d) => {
      const on = !d[key]
      return { ...d, [key]: on, order: orderOf(d).filter((a) => (a === key ? on : d[a])) }
    })
  const move = (key: Axis, dir: -1 | 1) =>
    saveDims((d) => {
      const next = orderOf(d)
      const i = next.indexOf(key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= next.length) return d
      ;[next[i], next[j]] = [next[j], next[i]]
      return { ...d, order: next.filter((a) => d[a]) }
    })
  if (!dims) return null
  const order = orderOf(dims)
  return (
    <details className="dc-axes">
      <summary>{t('discover.axesTitle')}</summary>
      <p className="dc-axes-hint">{t('suggestions.upgradeOrderHint')}</p>
      <ol className="axes">
        {order.map((k, i) => {
          const name = t(`discover.axis.${k}`)
          return (
            <li key={k} data-off={dims[k] ? undefined : ''}>
              <Checkbox checked={dims[k]} onChange={() => toggle(k)} label={name} />
              <span>
                <IconButton
                  size="sm"
                  aria-label={t('suggestions.moveUp', { axis: name })}
                  disabled={!dims[k] || i === 0}
                  onClick={() => move(k, -1)}
                >
                  <ArrowUp aria-hidden size="1em" />
                </IconButton>
                <IconButton
                  size="sm"
                  aria-label={t('suggestions.moveDown', { axis: name })}
                  disabled={!dims[k] || i === order.length - 1 || !dims[order[i + 1]]}
                  onClick={() => move(k, 1)}
                >
                  <ArrowDown aria-hidden size="1em" />
                </IconButton>
              </span>
            </li>
          )
        })}
      </ol>
    </details>
  )
}

/** Upgrades: better copies of what is on disk, loaded with one button, the old one to the trash. */
export function UpgradesSection() {
  const { t } = useTranslation()
  const { data: defaults } = useWatchDefaults()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const fail = useFailToast()
  const { data, isLoading, isError, refetch } = useSuggestions()
  const { data: dims } = usePersistedQuery<UpgradeDims>('upgrade-dims', () => api.get('/api/auth/upgrade-dims'))
  const [sync, setSync] = useState<SyncRequest | null>(null)
  const { open: openSeries } = useSeriesModal()
  // per-row chosen copy among the server copies; default = the recommended one
  const [choice, setChoice] = useState<Record<string, UpgradeVariant>>({})
  const hide = useDismiss()
  const list = useRef<HTMLDivElement>(null)
  const items = data?.upgrades ?? []
  const waiting = isLoading || (!items.length && !!data?.building)
  useLateRise(list, !waiting)

  const withDefaults = (r: SyncRequest, u: UpgradeSuggestion): SyncRequest => ({
    ...r,
    initial: applyDefaults(r.initial, suggestionKind(u.category), defaults),
  })
  const load = async (r: SyncRequest, u: UpgradeSuggestion, replaceOld: boolean) => {
    try {
      const res = await api.post<SyncResult>('/api/downloads/sync', {
        serverId: r.serverId,
        ...withDefaults(r, u).initial,
        replaceOld,
      })
      const why = syncOutcome(res, t)
      if (why) {
        toast({ message: why })
        return
      }
      qc.invalidateQueries({ queryKey: ['downloads'] })
      toast({ message: t(replaceOld ? 'discover.upgradeRunsTrash' : 'discover.upgradeRuns', { name: u.title }) })
    } catch (e) {
      fail(e)
    }
  }

  return (
    <div ref={list}>
      <UpgradeAxes />
      {isError && data && <LoadFailed stale onRetry={() => void refetch()} />}
      {waiting ? (
        <SkeletonRows />
      ) : isError && !data ? (
        <LoadFailed onRetry={() => void refetch()} />
      ) : !items.length ? (
        <EmptyNote title={t('suggestions.noUpgrades')} />
      ) : (
        <Rows>
          {items.map((u, i) => (
            <UpgradeCard
              key={u.key || `${u.showKey}-${u.season}-${i}`}
              u={u}
              dims={dims}
              chosen={choice[u.key] ?? u.to}
              onChoose={(o) => setChoice((c) => ({ ...c, [u.key]: o }))}
              onSync={(r) => setSync(withDefaults(r, u))}
              onLoad={(r, replaceOld) => load(r, u, replaceOld)}
              onDismiss={(x, from) =>
                void hide({ kind: 'upgrade', refKey: x.key, label: x.title, cover: x.cover, section: 'upgrades' }, from)
              }
              onOpenRemote={(v) => navigate(`/files?server=${v.serverId}&path=${encodeURIComponent(v.folder)}`)}
              onDetails={(x) =>
                openSeries({ source: suggestionSource(x), id: x.media!.id, media: x.media, title: x.title })
              }
            />
          ))}
        </Rows>
      )}
      {sync && (
        <WatchDialog
          title={sync.name}
          serverId={sync.serverId}
          initial={sync.initial}
          info={sync.info}
          saveLabel={t('discover.upgradeLoad')}
          onSave={async (f) => {
            const r = await api.post<SyncResult>('/api/downloads/sync', { serverId: sync.serverId, ...f })
            const why = syncOutcome(r, t)
            if (why) return why
            qc.invalidateQueries({ queryKey: ['downloads'] })
            toast({ message: t('discover.queued', { name: sync.name, count: r.queued }) })
          }}
          onClose={() => setSync(null)}
        />
      )}
    </div>
  )
}

// ── Duplicates ──

/** Duplikate: what the library holds twice, the copy the quality order keeps marked. */
export function DuplicatesSection() {
  const fail = useFailToast()
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: user } = useAuth()
  const { data, isLoading, isError, refetch } = useSuggestions()
  const hide = useDismiss()
  const now = useNow()
  const list = useRef<HTMLDivElement>(null)
  const items = data?.duplicates ?? []
  const waiting = isLoading || (!items.length && !!data?.building)
  useLateRise(list, !waiting)

  // one copy (a folder, or one file of a doubled episode) goes to the trash
  // folder beside it. The trash keeps it, so no question first: the undo
  // takes it back out, found by the folder it came from and its name.
  const trash = async (path: string) => {
    const name = path.split('/').findLast(Boolean) ?? path
    const dir = path.slice(0, path.lastIndexOf('/'))
    const refresh = () => {
      qc.invalidateQueries({ queryKey: ['suggestions'] })
      qc.invalidateQueries({ queryKey: ['trash'] })
    }
    try {
      await api.post('/api/suggestions/duplicates/trash', { path })
      refresh()
      toast({
        message: t('suggestions.dupTrashed', { name }),
        undo: () =>
          void (async () => {
            const found = (await api.get<TrashEntry[]>('/api/trash'))
              .filter((e) => e.name === name && e.dir.replace(/\/$/, '') === dir)
              .sort((a, b) => b.trashedAt - a.trashedAt)[0]
            if (found) await api.post('/api/trash/restore', { path: found.path })
            refresh()
          })().catch(fail),
      })
    } catch (e) {
      fail(e)
    }
  }
  const trashLink = (path: string) =>
    user?.isAdmin ? <TextLink onClick={() => void trash(path)}>{t('suggestions.dupTrash')}</TextLink> : null

  if (waiting)
    return (
      <div ref={list}>
        <SkeletonRows n={3} />
      </div>
    )
  if (isError && !data)
    return (
      <div ref={list}>
        <LoadFailed onRetry={() => void refetch()} />
      </div>
    )
  if (!items.length)
    return (
      <div ref={list}>
        {isError && <LoadFailed stale onRetry={() => void refetch()} />}
        <EmptyNote
          title={t('discover.empty.duplicates')}
          sub={data?.builtAt ? asOfLine(data.builtAt * 1000, now, i18n.language, t) : t('discover.recheck')}
        />
      </div>
    )
  return (
    <div ref={list}>
      {isError && <LoadFailed stale onRetry={() => void refetch()} />}
      {user?.isAdmin && <p className="dc-axes-hint">{t('suggestions.dupTrashHint')}</p>}
      <Rows>
        {items.map((d) => (
          <SugRow
            key={d.refKey}
            title={d.title}
            season={d.isMovie ? undefined : d.season > 0 ? t('suggestions.season', { season: d.season }) : undefined}
            meta={metaLine({ category: d.category, library: d.library }, t)}
            cover={d.cover ? { src: d.cover } : undefined}
          >
            {d.why && <span className="sg-why">{d.why}</span>}
            <span className="sg-why sg-warn">
              {d.episodes?.length
                ? t('suggestions.dupEpisodes', { list: fmtEpisodeRanges(d.episodes) })
                : t('suggestions.dupCopies', { count: d.copies.length })}
            </span>
            <span className="dup-copies">
              {d.copies.map((c) => {
                const keep = c.folder === d.keep && d.copies.length > 1
                return (
                  <div key={c.folder} data-keep={keep || undefined}>
                    <i>{keep ? t('suggestions.dupKeep') : t('discover.copy')}</i>
                    <span>
                      {copyLine(c, t)} · {t('suggestions.dupFiles', { count: c.files })} · {fmtBytes(c.bytes)}
                    </span>
                    <span className="mono" title={c.folder}>
                      {c.folder}
                    </span>
                    {d.copies.length > 1 && c.folder !== d.keep && trashLink(c.folder)}
                  </div>
                )
              })}
            </span>
            {d.twice?.length ? (
              <ul className="dup-twice">
                {d.twice.map((e) => (
                  <li key={e.episode}>
                    <span className="sg-warn">{t('suggestions.dupEpisode', { n: e.episode })}</span>
                    <ul>
                      {e.files.map((f) => (
                        <li key={f.path}>
                          <span className="mono" title={f.path}>
                            {f.path.split('/').pop()} · {fmtBytes(f.bytes)}
                          </span>
                          {trashLink(f.path)}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : null}
            <span className="sg-acts">
              <TextLink
                onClick={(e) =>
                  void hide(
                    { kind: 'duplicate', refKey: d.refKey, label: d.title, cover: d.cover, section: 'duplicates' },
                    e.currentTarget,
                  )
                }
              >
                {t('suggestions.dismiss')}
              </TextLink>
            </span>
          </SugRow>
        ))}
      </Rows>
    </div>
  )
}
