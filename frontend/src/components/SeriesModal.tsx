import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Clock,
  Download,
  Ellipsis,
  ExternalLink,
  FolderClock,
  Languages,
  MessageSquare,
  Pause,
  Pencil,
  Radio,
  RefreshCw,
  Star,
  Trash2,
  TriangleAlert,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Badge, Button, Cover, Dialog, IconButton, Menu, MenuItem, Progress, Tab, Tabs, useMenu } from '@weebsync/design-system'
import { api, fmtMissing, mediaTitle, watchTitle, type Media, type MediaExtras, type Review, type Watch } from '../api'
import { useNow } from '../hooks'
import MediaDetail, { GenreChips } from './MediaDetail'
import WatchEpisodesList from './WatchEpisodes'
import WatchDialog from './WatchDialog'
import { useWatchActions, watchFields } from './watchActions'

/** What a caller hands the title card: which title, and what it already knows. */
export interface SeriesTarget {
  /** anilist (default) | tmdb:tv | tmdb:movie */
  source?: string
  id: number
  /** the record the caller holds; the card fetches what is missing */
  media?: Media
  /** the watch the caller came from, listed first among the title's watches */
  watchId?: number
  /** the heading, where the caller knows a better one than the record's */
  title?: string
  /** which tab to land on */
  tab?: SeriesTab
  /** caller-specific rows under the record, e.g. the catalog's folder versions */
  extra?: ReactNode
}

export type SeriesTab = 'overview' | 'sync' | 'cast' | 'community' | 'similar'

interface SeriesModalApi {
  open: (target: SeriesTarget) => void
  close: () => void
}

const Ctx = createContext<SeriesModalApi | null>(null)

/** The one way to open the title card, from any cover in the app. */
export function useSeriesModal(): SeriesModalApi {
  const api = useContext(Ctx)
  if (!api) throw new Error('useSeriesModal outside SeriesModalProvider')
  return api
}

/**
 * Holds the title card the whole app shares. One dialog instead of one per
 * page: a cover opens the same thing everywhere, and the card can grow tabs
 * without every caller learning about them. A route change closes it - the
 * catalog's rows navigate, and a card left open over another page would be a
 * door into the wrong room.
 */
export function SeriesModalProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<SeriesTarget | null>(null)
  const { pathname } = useLocation()
  useEffect(() => setTarget(null), [pathname])
  const open = useCallback((t: SeriesTarget) => setTarget({ ...t, source: t.source || 'anilist' }), [])
  const close = useCallback(() => setTarget(null), [])
  const api = useMemo(() => ({ open, close }), [open, close])
  return (
    <Ctx.Provider value={api}>
      {children}
      {/* keyed on the title: a second open() from a page is a new card, while
          a related title picked inside the card stacks within the same one */}
      {target && <SeriesDialog key={`${target.source}:${target.id}`} target={target} onClose={close} />}
    </Ctx.Provider>
  )
}

// icon per AniList airing status, shown inside the chip
const MEDIA_STATUS_ICON: Record<string, LucideIcon> = {
  RELEASING: Radio,
  FINISHED: Check,
  NOT_YET_RELEASED: Clock,
  CANCELLED: X,
  HIATUS: Pause,
}

const TABS: SeriesTab[] = ['overview', 'sync', 'cast', 'community', 'similar']

function SeriesDialog({ target, onClose }: { target: SeriesTarget; onClose: () => void }) {
  const { t } = useTranslation()
  // the trail of related titles opened from inside the card; the first entry
  // is what the page opened, the last is what is shown
  const [stack, setStack] = useState<SeriesTarget[]>([target])
  const [wanted, setTab] = useState<SeriesTab>(target.tab ?? 'overview')
  const cur = stack[stack.length - 1]
  const source = cur.source || 'anilist'
  const push = (next: SeriesTarget) => {
    setStack((s) => [...s, { ...next, source: next.source || 'anilist' }])
    setTab('overview')
  }
  const back = () => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
    setTab('overview')
  }

  // a related title arrives as its trimmed node: fetch the record behind it
  const thin = !cur.media || cur.media.description === undefined
  const { data: fetched } = useQuery<Media>({
    queryKey: ['media', source, cur.id],
    queryFn: () =>
      source.startsWith('tmdb:')
        ? api.get(`/api/tmdb/media?kind=${source.slice(5)}&id=${cur.id}`)
        : api.get(`/api/anilist/media/${cur.id}`),
    enabled: thin,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const media = fetched ?? cur.media

  // the watches behind the title: several are normal (a split season, two
  // servers); the one the caller came from leads
  const { data: watches = [] } = useQuery<Watch[]>({
    queryKey: ['watches'],
    queryFn: () => api.get('/api/watches'),
    staleTime: 10_000,
  })
  const mine = watches
    .filter((w) => w.media?.id === cur.id && (w.mediaSource || 'anilist') === source)
    .sort((a, b) => (a.id === cur.watchId ? -1 : b.id === cur.watchId ? 1 : a.id - b.id))

  const tabs = TABS.filter((k) => k !== 'sync' || mine.length > 0)
  // the auto-sync tab asked for before the watch list arrived, or for a title
  // that turns out to have none, lands on the overview
  const tab: SeriesTab = wanted === 'sync' && mine.length === 0 ? 'overview' : wanted
  const ids = useId()
  const name = cur.title || (media ? mediaTitle(media) : '')
  const MediaStatusIcon = media?.status ? MEDIA_STATUS_ICON[media.status] : undefined
  const now = useNow()

  // the secondary tabs load on first sight, never with the list
  const wantExtras = tab !== 'sync'
  const { data: extras, isError: extrasFailed } = useQuery<MediaExtras>({
    queryKey: ['media-extras', source, cur.id],
    queryFn: () => api.get(`/api/media/extras?source=${source}&id=${cur.id}`),
    enabled: wantExtras,
    staleTime: 5 * 60_000,
    retry: false,
  })

  return (
    <Dialog width="max-w-3xl" aria-label={t('remote.detailsFor', { name })} onClose={onClose}>
      <div className="dialog-body">
        <header className="relative shrink-0">
          {media?.bannerImage && <img src={media.bannerImage} alt="" className="max-h-28 w-full object-cover" />}
          {stack.length > 1 && (
            <IconButton aria-label={t('series.back')} title={t('series.back')} onClick={back} className="absolute top-2 left-2 bg-bg-card/90">
              <ArrowLeft aria-hidden size="1.2em" />
            </IconButton>
          )}
          <div className="flex gap-4 px-5 pt-4 pb-3">
            {media?.coverImage?.large && <Cover src={media.coverImage.large} size="md" />}
            <div className="min-w-0 flex-1">
              <h3 className="font-display font-semibold tracking-wider">{name}</h3>
              {media?.title.english && media.title.english !== name && !/[぀-ヿ㐀-鿿]/.test(media.title.english) && (
                <p className="text-sm text-t-muted">{media.title.english}</p>
              )}
              {media && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {media.seasonYear > 0 && <Badge>{media.seasonYear}</Badge>}
                  {media.format && <Badge>{media.format}</Badge>}
                  {media.episodes > 0 && <Badge>{media.episodes} EP</Badge>}
                  {media.status && (
                    <Badge>
                      {MediaStatusIcon && <MediaStatusIcon aria-hidden size="1em" />}
                      {t(`remote.status.${media.status}`, media.status)}
                    </Badge>
                  )}
                  {media.averageScore > 0 && (
                    <Badge tone="accent">
                      <Star aria-hidden size="1em" className="mr-0.5 inline align-[-0.125em]" fill="currentColor" strokeWidth={0} />
                      {media.averageScore}
                    </Badge>
                  )}
                </div>
              )}
              <GenreChips genres={media?.genres} />
            </div>
          </div>
          <Tabs aria-label={t('series.tabsLabel')} className="mx-5">
            {tabs.map((k) => (
              <Tab key={k} id={`${ids}-tab-${k}`} aria-controls={`${ids}-panel-${k}`} selected={tab === k} onClick={() => setTab(k)}>
                {t(`series.tab.${k}`)}
                {k === 'sync' && mine.length > 1 && <span className="t-count ml-1.5">{mine.length}</span>}
              </Tab>
            ))}
          </Tabs>
        </header>

        <div id={`${ids}-panel-${tab}`} role="tabpanel" aria-labelledby={`${ids}-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'overview' && media && (
            <MediaDetail media={media} source={source} airings={mine[0]?.airings} links={extras?.links} now={now}>
              {cur.extra}
            </MediaDetail>
          )}
          {tab === 'sync' && (
            <div className="grid gap-4 p-5">
              {mine.map((w) => (
                <WatchBlock key={w.id} watch={w} onGone={mine.length === 1 ? onClose : undefined} />
              ))}
            </div>
          )}
          {tab === 'cast' && (
            <div className="p-5">
              <Unavailable when={extrasFailed} source={source} />
              {extras && extras.characters.length === 0 && <p className="text-sm text-t-muted">{t('series.noCast')}</p>}
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
                {extras?.characters.map((c) => (
                  <li key={`${c.name}-${c.voiceActor}`} className="flex items-center gap-2">
                    {c.image ? (
                      <img src={c.image} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-full object-cover" />
                    ) : (
                      <span aria-hidden className="t-hatch h-12 w-12 shrink-0 rounded-full" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-t-primary">{c.name}</span>
                      {c.voiceActor && <span className="block truncate text-[11px] text-t-muted">{c.voiceActor}</span>}
                      {c.role && c.role !== 'MAIN' && <span className="block text-[10px] uppercase text-t-faint">{t(`series.role.${c.role}`, c.role)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {tab === 'community' && <Community source={source} id={cur.id} threads={extras?.threads} failed={extrasFailed} />}
          {tab === 'similar' && (
            <div className="p-5">
              <Unavailable when={extrasFailed} source={source} />
              {extras && extras.relations.length === 0 && extras.recommendations.length === 0 && (
                <p className="text-sm text-t-muted">{t('series.noSimilar')}</p>
              )}
              {!!extras?.relations.length && (
                <section>
                  <h4 className="t-label mb-2">{t('series.relations')}</h4>
                  <PosterRow
                    items={extras.relations.map((r) => ({ media: r.node, caption: t(`series.relation.${r.relationType}`, r.relationType) }))}
                    onPick={(m) => push({ id: m.id, media: m })}
                  />
                </section>
              )}
              {!!extras?.recommendations.length && (
                <section className="mt-4">
                  <h4 className="t-label mb-2">{t('series.recommendations')}</h4>
                  <PosterRow items={extras.recommendations.map((m) => ({ media: m }))} onPick={(m) => push({ source, id: m.id, media: m })} />
                </section>
              )}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <Button size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </footer>
      </div>
    </Dialog>
  )
}

// one line, where the source is down: the tab is not broken, the provider is
function Unavailable({ when, source }: { when: boolean; source: string }) {
  const { t } = useTranslation()
  if (!when) return null
  return (
    <p className="mb-3 text-sm text-err" role="status">
      {t('series.unavailable', { source: source.startsWith('tmdb') ? 'TMDB' : 'AniList' })}
    </p>
  )
}

function PosterRow({ items, onPick }: { items: { media: Media; caption?: string }[]; onPick: (m: Media) => void }) {
  const { t } = useTranslation()
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-3">
      {items.map(({ media: m, caption }) => (
        <li key={`${m.id}-${caption ?? ''}`} className="min-w-0">
          <button type="button" onClick={() => onPick(m)} aria-label={t('remote.detailsFor', { name: mediaTitle(m) })} className="w-full cursor-pointer text-left">
            <Cover src={m.coverImage?.large} size="fill" loading="lazy" className="rounded-xs" />
            {caption && <span className="mt-1 block text-[10px] uppercase tracking-wider text-accent">{caption}</span>}
            <span className="line-clamp-2 text-xs text-t-primary">{mediaTitle(m)}</span>
            {m.seasonYear > 0 && <span className="block text-[11px] text-t-muted">{m.seasonYear}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

function Community({ source, id, threads, failed }: { source: string; id: number; threads?: MediaExtras['threads']; failed: boolean }) {
  const { t } = useTranslation()
  const [allReviews, setAllReviews] = useState(false)
  const { data: rev, isError: reviewsFailed } = useQuery<{ reviews: Review[] }>({
    queryKey: ['reviews', source, id],
    queryFn: () => api.get(`/api/media/reviews?source=${source}&id=${id}`),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const when = (ts?: number) => (ts ? new Date(ts * 1000).toLocaleDateString() : '')
  return (
    <div className="p-5">
      <Unavailable when={failed || reviewsFailed} source={source} />
      {!source.startsWith('tmdb') && (
        <section className="mb-4">
          <h4 className="t-label mb-2">{t('series.threads')}</h4>
          {threads && threads.length === 0 && <p className="text-sm text-t-muted">{t('series.noThreads')}</p>}
          <ul className="grid gap-1">
            {threads?.map((th) => (
              <li key={th.id}>
                <a
                  href={th.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm hover:bg-bg-hover"
                >
                  <MessageSquare aria-hidden size="1em" className="shrink-0 text-t-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-t-primary">{th.title}</span>
                    <span className="block truncate text-[11px] text-t-muted">
                      {[th.user, th.category, when(th.repliedAt)].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <Badge size="sm">{t('series.replies', { count: th.replies })}</Badge>
                  <ExternalLink aria-hidden size="1em" className="shrink-0 text-t-muted" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h4 className="t-label mb-2">
          {t('remote.reviews')}
          {rev ? ` (${rev.reviews.length})` : ''}
        </h4>
        {rev && rev.reviews.length === 0 && <p className="text-sm text-t-muted">{t('remote.noReviews')}</p>}
        {/* chat-bubble layout: avatar beside a bordered bubble per review */}
        <ul className="grid gap-3">
          {(allReviews ? rev?.reviews : rev?.reviews.slice(0, 5))?.map((r, i) => (
            <li key={i} className="flex items-start gap-3">
              {r.user.avatar?.medium ? (
                <img src={r.user.avatar.medium} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
              ) : (
                <div aria-hidden className="t-hatch flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-display text-xs text-t-muted">
                  {r.user.name.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-secondary p-3 text-sm text-t-secondary">
                <p className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge>{r.user.name}</Badge>
                  {r.score > 0 && (
                    <Badge tone="accent">
                      <Star aria-hidden size="1em" className="mr-0.5 inline align-[-0.125em]" fill="currentColor" strokeWidth={0} />
                      {r.score}
                    </Badge>
                  )}
                </p>
                <p className="whitespace-pre-line">{r.summary}</p>
              </div>
            </li>
          ))}
        </ul>
        {!allReviews && rev && rev.reviews.length > 5 && (
          <Button size="sm" className="mt-3" onClick={() => setAllReviews(true)}>
            <ChevronDown aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('remote.moreReviews', { count: rev.reviews.length - 5 })}
          </Button>
        )}
      </section>
    </div>
  )
}

/**
 * One watch of the title: where it syncs, what needs a hand, how far it is,
 * and everything that can be done to it - check now up front, the rest
 * behind the overflow menu. The episode list sits under it.
 */
function WatchBlock({ watch: w, onGone }: { watch: Watch; onGone?: () => void }) {
  const { t } = useTranslation()
  const act = useWatchActions()
  const [edit, setEdit] = useState(false)
  const menu = useMenu()
  const total = w.media?.episodes ?? 0
  const pct = total > 0 ? (w.localFiles / total) * 100 : w.complete ? 100 : 0
  const canPlex = !!(w.plexAudioLang || w.plexSubLang)
  return (
    <section className="rounded-lg border border-border-subtle p-3" aria-label={watchTitle(w)}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-t-muted" title={w.remotePath}>
          {w.serverName}:{w.remotePath} → {w.localPath}
        </p>
        <Button size="sm" onClick={() => act.check(w.id)}>
          <RefreshCw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('watch.checkNow')}
        </Button>
        <div className="relative" ref={menu.ref} style={menu.anchorStyle}>
          <IconButton aria-label={t('watch.moreActions', { title: watchTitle(w) })} aria-haspopup="listbox" aria-expanded={menu.open} onClick={() => menu.setOpen(!menu.open)}>
            <Ellipsis aria-hidden size="1.2em" />
          </IconButton>
          {menu.open && (
            <Menu anchor={menu.anchor} placement="bottom-end" aria-label={t('watch.moreActions', { title: watchTitle(w) })}>
              <MenuItem
                onClick={() => {
                  menu.setOpen(false)
                  setEdit(true)
                }}
              >
                <Pencil aria-hidden size="1em" className="mr-2 inline align-[-0.125em]" />
                {t('servers.edit')}
              </MenuItem>
              {canPlex && (
                <MenuItem
                  onClick={() => {
                    menu.setOpen(false)
                    void act.applyPlexStreams(w.id)
                  }}
                >
                  <Languages aria-hidden size="1em" className="mr-2 inline align-[-0.125em]" />
                  {t('watch.plexApplyAll')}
                </MenuItem>
              )}
              <MenuItem
                className="text-err"
                onClick={async () => {
                  menu.setOpen(false)
                  if (await act.del(w)) onGone?.()
                }}
              >
                <Trash2 aria-hidden size="1em" className="mr-2 inline align-[-0.125em]" />
                {t('servers.delete')}
              </MenuItem>
            </Menu>
          )}
        </div>
      </div>
      {(act.error || w.lastResult) && <p className="mt-2 text-[11px] text-err">{act.error || w.lastResult}</p>}
      {act.notice && (
        <p className="mt-2 text-[11px] text-accent" role="status">
          {act.notice}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]">
        {!!w.nextAiringAt && (
          <Badge tone={w.behind ? 'warn' : 'ok'} size="sm">
            {t('watch.chipEp', { n: w.nextEpisode })}
            {w.nextEpisodeAbs && w.nextEpisodeAbs !== w.nextEpisode ? ` (${w.nextEpisodeAbs})` : ''}
            {' · '}
            {new Date(w.nextAiringAt * 1000).toLocaleString([], { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </Badge>
        )}
        {(w.behind ?? 0) > 0 && (
          <Badge tone="warn" size="sm">
            <Clock aria-hidden size="1em" />
            {t('watch.behind', { count: w.behind })}
          </Badge>
        )}
        {(w.missing?.length ?? 0) > 0 && (
          <Badge tone="err" size="sm" title={w.missing!.join(', ')}>
            <TriangleAlert aria-hidden size="1em" />
            {t('watch.missing', { count: w.missing!.length, eps: fmtMissing(w.missing!, w.offset) })}
          </Badge>
        )}
        {(w.unsorted ?? 0) > 0 && (
          <Badge tone="warn" size="sm" title={t('watch.unsortedHint')}>
            <FolderClock aria-hidden size="1em" />
            {t('watch.unsorted', { count: w.unsorted })}
          </Badge>
        )}
        {(w.langWaiting ?? 0) > 0 && (
          <Badge tone="warn" size="sm">
            <Clock aria-hidden size="1em" />
            {t('watch.langWaiting', {
              count: w.langWaiting,
              lang: [w.wantDub && `${w.wantDub}-Dub`, w.wantSub && `${w.wantSub}-Sub`].filter(Boolean).join('/'),
            })}
          </Badge>
        )}
        {w.plexStreamMiss && (
          <Badge tone="warn" size="sm" title={t('watch.plexMissHint')}>
            <Languages aria-hidden size="1em" />
            {t('watch.plexMiss', {
              what: w.plexStreamMiss
                .split(',')
                .map((d) => t(d === 'audio' ? 'watch.plexAudio' : 'watch.plexSub'))
                .join(', '),
            })}
          </Badge>
        )}
        {w.lastUploading > 0 && (
          <Badge tone="warn" size="sm">
            <Upload aria-hidden size="1em" />
            {t('watch.uploading')}
          </Badge>
        )}
        {w.active > 0 && (
          <Badge tone="accent" size="sm">
            <Download aria-hidden size="1em" />
            {t('watch.active', { count: w.active })}
          </Badge>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs">
        <Progress value={pct} size="sm" tone={w.complete ? 'ok' : 'accent'} label={t('series.progressLabel', { name: watchTitle(w) })} className="w-32" />
        <span className={w.complete ? 'text-ok' : 'text-t-secondary'}>
          {total > 0 ? t('watch.episodes', { have: w.localFiles, total }) : t('watch.files', { count: w.localFiles })}
        </span>
        {w.complete && (
          <span className="text-ok">
            <Check aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('watch.complete')}
          </span>
        )}
      </div>
      <div className="mt-3 border-t border-border-subtle pt-3">
        <WatchEpisodesList watch={w} />
      </div>
      {edit && (
        <WatchDialog
          title={t('watch.editTitle')}
          serverId={w.serverId}
          watchId={w.id}
          initial={watchFields(w)}
          onSave={(f) => act.save(w.id, f)}
          onClose={() => setEdit(false)}
        />
      )}
    </section>
  )
}
