import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { flushSync } from 'react-dom'
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
import {
  Badge,
  Button,
  Cover,
  Dialog,
  IconButton,
  Menu,
  MenuItem,
  morphTransition,
  Progress,
  useMenu,
} from '@weebsync/design-system'
import {
  api,
  fmtMissing,
  langLabel,
  mediaTitle,
  watchTitle,
  type Media,
  type MediaExtras,
  type Review,
  type Watch,
} from '../api'
import { dubOverdueLabel, dubWaitingLabel } from '../attention'
import { useNow } from '../hooks'
import ActionMenu from './ActionMenu'
import type { SheetAction } from './ActionSheet'
import MediaDetail, { GenreChips } from './MediaDetail'
import WatchEpisodesList from './WatchEpisodes'
import { WatchForm } from './WatchDialog'
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
  /** the section to scroll to on open */
  tab?: SeriesTab
  /** caller-specific rows under the record, e.g. the catalog's folder versions */
  extra?: ReactNode
  /**
   * What can be done with the title where the card was opened, for its action
   * bar. Without any, a card opened from a watch offers checking and editing
   * that watch.
   */
  actions?: SeriesAction[]
}

/** One action of the card's bar. */
export interface SeriesAction extends SheetAction {
  /** the one filled button, at the end of the bar */
  primary?: boolean
  /** a rare one, behind the ⋯ menu */
  more?: boolean
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
  // a route change closes the card: derived in render, not in an effect, so
  // the closed state is what the new page's first frame sees
  const { pathname } = useLocation()
  const [at, setAt] = useState(pathname)
  if (at !== pathname) {
    setAt(pathname)
    setTarget(null)
  }
  // The dialog grows out of the poster that was clicked and shrinks back into
  // it on close (morphTransition) - on a desktop; on a phone the sheet rises
  // from the bottom edge. The poster is the one under the click that opened
  // the card: a capture listener notes it just before the click reaches the
  // page's own handler.
  const lastCover = useRef<{ el: HTMLElement; at: number } | null>(null)
  useEffect(() => {
    const note = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.t-cover')
      lastCover.current = el ? { el, at: performance.now() } : null
    }
    document.addEventListener('click', note, true)
    return () => document.removeEventListener('click', note, true)
  }, [])
  const [origin, setOrigin] = useState<HTMLElement | null>(null)
  const open = useCallback((t: SeriesTarget) => {
    const from = lastCover.current
    lastCover.current = null
    const el = from && from.el.isConnected && performance.now() - from.at < 500 ? from.el : null
    const next = () => {
      setTarget({ ...t, source: t.source || 'anilist' })
      setOrigin(el)
    }
    if (el) void morphTransition(el, () => flushSync(next))
    else next()
  }, [])
  const close = useCallback(() => setTarget(null), [])
  const api = useMemo(() => ({ open, close }), [open, close])
  return (
    <Ctx.Provider value={api}>
      {children}
      {/* keyed on the title: a second open() from a page is a new card, while
          a related title picked inside the card stacks within the same one */}
      {target && <SeriesDialog key={`${target.source}:${target.id}`} target={target} origin={origin} onClose={close} />}
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

// the order the sections stand in on the one scrolling page
const SECTIONS: SeriesTab[] = ['overview', 'sync', 'cast', 'similar', 'community']
// the docked title bar's height (h-11), and the scroll over which it fades in
const DOCK_PX = 44
const DOCK_FADE = 40
// the docked title plus the jump row: where a section's top lands after a jump
const STICKY_PX = 88

const reducedMotion = () =>
  document.documentElement.dataset.motion === 'off' ||
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

function SeriesDialog({
  target,
  origin,
  onClose,
}: {
  target: SeriesTarget
  /** the poster the dialog grew out of, to shrink back into */
  origin: HTMLElement | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  // the trail of related titles opened from inside the card; the first entry
  // is what the page opened, the last is what is shown
  const [stack, setStack] = useState<SeriesTarget[]>([target])
  const cur = stack[stack.length - 1]
  const source = cur.source || 'anilist'
  // another title in the same card starts at its top, head and back button
  // in view, whatever the last one was scrolled to
  const fresh = useRef(false)
  const push = (next: SeriesTarget) => {
    fresh.current = true
    setStack((s) => [...s, { ...next, source: next.source || 'anilist' }])
  }
  const back = () => {
    fresh.current = true
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
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
  const { data: watches = [], isSuccess: watchesIn } = useQuery<Watch[]>({
    queryKey: ['watches'],
    queryFn: () => api.get('/api/watches'),
    staleTime: 10_000,
  })
  const mine = watches
    .filter((w) => w.media?.id === cur.id && (w.mediaSource || 'anilist') === source)
    .sort((a, b) => (a.id === cur.watchId ? -1 : b.id === cur.watchId ? 1 : a.id - b.id))

  // One page instead of tabs: every section stands under the last, the
  // auto-sync one only for a title that has a watch. The tabs hid four of
  // five parts behind a tap, and their swipe fought the sheet's own.
  const sections = SECTIONS.filter((k) => k !== 'sync' || mine.length > 0)
  const ids = useId()
  const name = cur.title || (media ? mediaTitle(media) : '')
  const MediaStatusIcon = media?.status ? MEDIA_STATUS_ICON[media.status] : undefined
  const now = useNow()

  // Editing a watch swaps the card's content for the editor, in the same
  // dialog, rather than stacking a second modal on it: in from the right, and
  // the card back in from the left (shared axis, the route motion's classes,
  // which the reduced-motion gate already stills). The card unmounts while
  // it is away, so where it was scrolled to and which block asked are kept
  // for the way back.
  const act = useWatchActions()
  const [editing, setEditing] = useState<Watch | null>(null)
  const [returned, setReturned] = useState(false)
  const guard = useRef<() => Promise<boolean>>(async () => true)
  const away = useRef<{ top: number; focus: string } | null>(null)
  // `focus` is where focus goes on the way back: by default the menu of the
  // watch's block, since the menu item that had it is gone
  const edit = (w: Watch, focus = `[data-watch="${w.id}"] [aria-haspopup]`) => {
    away.current = { top: scroller.current?.scrollTop ?? 0, focus }
    setEditing(w)
  }
  const leave = () => {
    setEditing(null)
    setReturned(true)
  }
  const from = mine.find((w) => w.id === cur.watchId)
  const actions: SeriesAction[] =
    cur.actions ??
    (from
      ? [
          {
            key: 'check',
            label: t('watch.checkNow'),
            icon: <RefreshCw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />,
            primary: true,
            onClick: () => void act.check(from.id),
          },
          {
            key: 'edit',
            label: t('servers.edit'),
            icon: <Pencil aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />,
            onClick: () => edit(from, '[data-action="edit"]'),
          },
        ]
      : [])

  // Cast, similar titles and the community load once their sections come
  // near the viewport, as the tabs loaded on first sight: a card opened for
  // its auto-sync block never asks the provider for them. Without an
  // observer (an old engine, the tests) they load at once.
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined' || !!target.tab)
  const { data: extras, isError: extrasFailed } = useQuery<MediaExtras>({
    queryKey: ['media-extras', source, cur.id],
    queryFn: () => api.get(`/api/media/extras?source=${source}&id=${cur.id}`),
    enabled: near,
    staleTime: 5 * 60_000,
    retry: false,
  })

  // The banner's lag: it moves down at half the scroll, so the head slides
  // up over it. A transform only, written straight to the element - a state
  // update per scroll frame would re-render the whole dialog.
  const scroller = useRef<HTMLDivElement>(null)
  const banner = useRef<HTMLImageElement>(null)
  // Once the head has scrolled away, a slim bar holds the title above the
  // tabs: it fades in over the last stretch before the tabs stick (--q, 0..1),
  // so the reader never loses which series this is.
  const head = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)
  const stick = () => (head.current?.offsetHeight ?? 0) - DOCK_PX
  const lag = () => {
    // before the dialog has laid out there is no head to measure
    if (!head.current?.offsetHeight) return
    const top = scroller.current?.scrollTop ?? 0
    const still = reducedMotion()
    const s = stick()
    pinned.current = top >= s - 1
    // information, not decoration: without motion it is there or not
    const q = still ? (pinned.current ? 1 : 0) : Math.min(1, Math.max(0, (top - s + DOCK_FADE) / DOCK_FADE))
    dock.current?.style.setProperty('--q', q.toFixed(3))
    const b = banner.current
    if (!b) return
    // half the scroll, and darker as it goes: the head slides up over a
    // picture that falls back and dims
    const y = Math.min(top, 200)
    b.style.transform = still || y <= 0 ? '' : `translateY(${y * 0.5}px)`
    b.style.opacity = still || y <= 0 ? '' : String(1 - Math.min(1, y / 144) * 0.6)
  }

  // another title starts at its top; then the dock is redone, as the content
  // height has jumped
  useLayoutEffect(() => {
    const sc = scroller.current
    if (sc && fresh.current) sc.scrollTop = 0
    fresh.current = false
    lag()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur.id])

  // The jump row marks the section being read (aria-current): the first one
  // inside a band from under the sticky rows to the middle of the scroller.
  // A second observer watches the first lazy section come within a screen.
  const sec = useRef<Partial<Record<SeriesTab, HTMLElement | null>>>({})
  const [current, setCurrent] = useState<SeriesTab>('overview')
  useEffect(() => {
    const root = scroller.current
    if (!root || editing || typeof IntersectionObserver === 'undefined') return
    const seen = new Map<Element, boolean>()
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => seen.set(e.target, e.isIntersecting))
        // scrolled to the end, the last section is the one being read even
        // though a short one never reaches the top of the band
        const end = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2
        const first = end ? sections[sections.length - 1] : sections.find((k) => seen.get(sec.current[k]!))
        if (first) setCurrent(first)
      },
      { root, rootMargin: `-${STICKY_PX}px 0px -50% 0px` },
    )
    const ahead = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), {
      root,
      rootMargin: '0px 0px 100% 0px',
    })
    sections.forEach((k) => sec.current[k] && spy.observe(sec.current[k]))
    if (sec.current.cast) ahead.observe(sec.current.cast)
    return () => {
      spy.disconnect()
      ahead.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections.join(), editing, cur.id])

  const jump = (k: SeriesTab, smooth = true) => {
    const el = sec.current[k]
    const sc = scroller.current
    if (!el || !sc) return
    setCurrent(k)
    sc.scrollTo?.({ top: el.offsetTop - STICKY_PX, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' })
    // a keyboard user lands in the section, not back at the top of the row
    el.focus({ preventScroll: true })
  }
  // The caller's section (the dashboard opens on auto-sync): jumped to once
  // it exists - the auto-sync one appears with the watch list - and dropped
  // if the list arrives without it.
  const pending = useRef<SeriesTab | null>(target.tab && target.tab !== 'overview' ? target.tab : null)
  useLayoutEffect(() => {
    const k = pending.current
    if (!k || (!sec.current[k] && !watchesIn)) return
    pending.current = null
    if (sec.current[k]) jump(k, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.length, watchesIn])
  // back from the editor: the scroll it left, and focus where the edit came from
  useLayoutEffect(() => {
    const was = away.current
    if (editing || !was) return
    away.current = null
    if (scroller.current) scroller.current.scrollTop = was.top
    lag()
    scroller.current?.parentElement?.querySelector<HTMLElement>(was.focus)?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  return (
    <Dialog
      width="max-w-3xl"
      aria-label={t('remote.detailsFor', { name })}
      onClose={onClose}
      // Escape, the backdrop, the grabber and the back gesture still close the
      // whole card from the editor, but not past its unsaved changes
      onRequestClose={() => (editing ? guard.current() : true)}
      closeTransition={origin ? (close) => void morphTransition(origin, close, true) : undefined}
    >
      {editing ? (
        <WatchForm
          className="anim-route-push"
          title={t('watch.editTitle')}
          serverId={editing.serverId}
          watchId={editing.id}
          initial={watchFields(editing)}
          onSave={(f) => act.save(editing.id, f)}
          onClose={leave}
          onGuard={(check) => (guard.current = check)}
          onBack={async () => {
            if (await guard.current()) leave()
          }}
        />
      ) : (
        <div className={`dialog-body relative ${returned ? 'anim-route-pop' : ''}`}>
          <div ref={dock} aria-hidden className="t-dock pr-12">
            <span className="truncate">{name}</span>
          </div>
          {/* outside the scroller, so it stays at hand once the head is gone */}
          <IconButton
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => (origin ? void morphTransition(origin, () => flushSync(onClose), true) : onClose())}
            className="absolute top-1 right-2 z-30 bg-bg-card/90"
          >
            <X aria-hidden size="1.2em" />
          </IconButton>
          {/* One scroller for the head and the panel: the banner and the title
            scroll away and leave the room to the content, the tabs stay at the
            top. The banner lags behind the scroll, so it reads as further back
            than the page sliding over it. */}
          <div ref={scroller} onScroll={lag} className="min-h-0 flex-1 overflow-y-auto">
            <header ref={head} className="relative">
              {media?.bannerImage && (
                <div className="h-36 overflow-hidden bg-bg-hover">
                  <img
                    ref={banner}
                    src={media.bannerImage}
                    alt=""
                    className="h-full w-full object-cover will-change-transform"
                  />
                </div>
              )}
              {stack.length > 1 && (
                <IconButton
                  aria-label={t('series.back')}
                  title={t('series.back')}
                  onClick={back}
                  className="absolute top-2 left-2 bg-bg-card/90"
                >
                  <ArrowLeft aria-hidden size="1.2em" />
                </IconButton>
              )}
              <div className={`flex gap-4 px-5 pt-4 pb-3 ${media?.bannerImage ? '' : 'pr-12'}`}>
                {media?.coverImage?.large && (
                  <div className="shrink-0">
                    <Cover
                      src={media.coverImage.extraLarge || media.coverImage.large}
                      tint={media.coverImage.color ?? undefined}
                      size="md"
                    />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h3 className="font-display font-semibold tracking-wider">{name}</h3>
                  {media?.title.english && media.title.english !== name && !/[぀-ヿ㐀-鿿]/.test(media.title.english) && (
                    <p className="text-sm text-t-muted">{media.title.english}</p>
                  )}
                  {mine[0] && <StateLine watch={mine[0]} />}
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
                          <Star
                            aria-hidden
                            size="1em"
                            className="mr-0.5 inline align-[-0.125em]"
                            fill="currentColor"
                            strokeWidth={0}
                          />
                          {media.averageScore}
                        </Badge>
                      )}
                    </div>
                  )}
                  <GenreChips genres={media?.genres} />
                </div>
              </div>
            </header>
            <nav
              aria-label={t('series.sectionsLabel')}
              className="sticky top-11 z-10 border-b border-border-subtle bg-bg-card"
            >
              <div className="t-tabs t-tabs--line t-tabs--scroll px-3">
                {sections.map((k) => (
                  <a
                    key={k}
                    href={`#${ids}-${k}`}
                    className="t-tab"
                    aria-current={current === k ? 'true' : undefined}
                    onClick={(e) => {
                      e.preventDefault()
                      jump(k)
                    }}
                  >
                    {t(`series.tab.${k}`)}
                    {k === 'sync' && mine.length > 1 && <span className="t-count ml-1.5">{mine.length}</span>}
                  </a>
                ))}
              </div>
            </nav>

            {sections.map((k) => (
              <section
                key={k}
                id={`${ids}-${k}`}
                ref={(el) => {
                  sec.current[k] = el
                }}
                tabIndex={-1}
                aria-labelledby={`${ids}-${k}-h`}
                className="outline-none"
              >
                {/* the overview needs no visible heading right under the title */}
                <h4 id={`${ids}-${k}-h`} className={k === 'overview' ? 'sr-only' : 't-label px-5 pt-5'}>
                  {t(`series.tab.${k}`)}
                </h4>
                {k === 'overview' && media && (
                  <MediaDetail media={media} source={source} airings={mine[0]?.airings} links={extras?.links} now={now}>
                    {cur.extra}
                  </MediaDetail>
                )}
                {k === 'sync' && (
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-5 pt-3">
                    {mine.map((w) => (
                      <WatchBlock
                        key={w.id}
                        watch={w}
                        onEdit={() => edit(w)}
                        onGone={mine.length === 1 ? onClose : undefined}
                      />
                    ))}
                  </div>
                )}
                {k === 'cast' && (
                  <div className="p-5 pt-3">
                    <Unavailable when={extrasFailed} source={source} />
                    {extras && extras.characters.length === 0 && (
                      <p className="text-sm text-t-muted">{t('series.noCast')}</p>
                    )}
                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
                      {extras?.characters.map((c) => (
                        <li key={`${c.name}-${c.voiceActor}`} className="flex items-center gap-2">
                          {c.image ? (
                            <img
                              src={c.image}
                              alt=""
                              loading="lazy"
                              className="h-12 w-12 shrink-0 rounded-full object-cover"
                            />
                          ) : (
                            <span aria-hidden className="t-hatch h-12 w-12 shrink-0 rounded-full" />
                          )}
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-t-primary">{c.name}</span>
                            {c.voiceActor && (
                              <span className="block truncate text-[11px] text-t-muted">{c.voiceActor}</span>
                            )}
                            {c.role && c.role !== 'MAIN' && (
                              <span className="block text-[10px] uppercase text-t-faint">
                                {t(`series.role.${c.role}`, c.role)}
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {k === 'similar' && (
                  <div className="p-5 pt-3">
                    <Unavailable when={extrasFailed} source={source} />
                    {extras && extras.relations.length === 0 && extras.recommendations.length === 0 && (
                      <p className="text-sm text-t-muted">{t('series.noSimilar')}</p>
                    )}
                    {!!extras?.relations.length && (
                      <section>
                        <h5 className="t-label mb-2">{t('series.relations')}</h5>
                        <PosterRow
                          items={extras.relations.map((r) => ({
                            media: r.node,
                            caption: t(`series.relation.${r.relationType}`, r.relationType),
                          }))}
                          onPick={(m) => push({ id: m.id, media: m })}
                        />
                      </section>
                    )}
                    {!!extras?.recommendations.length && (
                      <section className="mt-4">
                        <h5 className="t-label mb-2">{t('series.recommendations')}</h5>
                        <PosterRow
                          items={extras.recommendations.map((m) => ({ media: m }))}
                          onPick={(m) => push({ source, id: m.id, media: m })}
                        />
                      </section>
                    )}
                  </div>
                )}
                {/* the reviews are a request of their own: not before the
                    section is near */}
                {k === 'community' && near && (
                  <Community source={source} id={cur.id} threads={extras?.threads} failed={extrasFailed} />
                )}
              </section>
            ))}
          </div>

          {/* What can be done with the title from here. No close button:
              the grabber, Escape, the back gesture and the header's X all
              close the card already, and the room is worth more to the
              thing the user came to do. */}
          {actions.length > 0 && (
            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
              {act.error && (
                <p className="mr-auto min-w-0 flex-1 text-[11px] text-err" role="status">
                  {act.error}
                </p>
              )}
              {actions
                .filter((a) => !a.more)
                .sort((a, b) => Number(!!a.primary) - Number(!!b.primary))
                .map((a) => (
                  <Button
                    key={a.key}
                    size="sm"
                    variant={a.primary ? 'primary' : a.danger ? 'danger' : 'default'}
                    data-action={a.key}
                    onClick={a.onClick}
                  >
                    {a.icon}
                    {a.label}
                  </Button>
                ))}
              <ActionMenu
                label={t('series.moreActions', { name })}
                title={name}
                actions={actions.filter((a) => a.more)}
              />
            </footer>
          )}
        </div>
      )}
    </Dialog>
  )
}

/**
 * What the user has of the title, in one line under its name: the first
 * question on opening the card, answered without scrolling to the auto-sync
 * block. From the lead watch: episodes on disk, the first hole, the next
 * airing.
 */
function StateLine({ watch: w }: { watch: Watch }) {
  const { t } = useTranslation()
  const total = w.media?.episodes ?? 0
  const parts = [
    total > 0
      ? t('series.state.local', { have: w.localFiles, total })
      : t('series.state.files', { count: w.localFiles }),
    w.missing?.length ? t('series.state.missing', { ep: fmtMissing(w.missing.slice(0, 1), w.offset) }) : '',
    w.nextAiringAt
      ? t('series.state.next', {
          n: w.nextEpisode,
          when: new Date(w.nextAiringAt * 1000).toLocaleString([], {
            weekday: 'short',
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }),
        })
      : '',
  ]
  return <p className="mt-1 text-xs text-t-secondary">{parts.filter(Boolean).join(' · ')}</p>
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
          <button
            type="button"
            onClick={() => onPick(m)}
            aria-label={t('remote.detailsFor', { name: mediaTitle(m) })}
            className="w-full cursor-pointer text-left"
          >
            <Cover
              src={m.coverImage?.large}
              tint={m.coverImage?.color ?? undefined}
              size="fill"
              loading="lazy"
              className="rounded-xs"
            />
            {caption && <span className="mt-1 block text-[10px] uppercase tracking-wider text-accent">{caption}</span>}
            <span className="line-clamp-2 text-xs text-t-primary">{mediaTitle(m)}</span>
            {m.seasonYear > 0 && <span className="block text-[11px] text-t-muted">{m.seasonYear}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

function Community({
  source,
  id,
  threads,
  failed,
}: {
  source: string
  id: number
  threads?: MediaExtras['threads']
  failed: boolean
}) {
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
    <div className="p-5 pt-3">
      <Unavailable when={failed || reviewsFailed} source={source} />
      {!source.startsWith('tmdb') && (
        <section className="mb-4">
          <h5 className="t-label mb-2">{t('series.threads')}</h5>
          {threads && threads.length === 0 && <p className="text-sm text-t-muted">{t('series.noThreads')}</p>}
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-1">
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
        <h5 className="t-label mb-2">
          {t('remote.reviews')}
          {rev ? ` (${rev.reviews.length})` : ''}
        </h5>
        {rev && rev.reviews.length === 0 && <p className="text-sm text-t-muted">{t('remote.noReviews')}</p>}
        {/* chat-bubble layout: avatar beside a bordered bubble per review */}
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
          {(allReviews ? rev?.reviews : rev?.reviews.slice(0, 5))?.map((r, i) => (
            <li key={i} className="flex items-start gap-3">
              {r.user.avatar?.medium ? (
                <img src={r.user.avatar.medium} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
              ) : (
                <div
                  aria-hidden
                  className="t-hatch flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-display text-xs text-t-muted"
                >
                  {r.user.name.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-secondary p-3 text-sm text-t-secondary">
                <p className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge>{r.user.name}</Badge>
                  {r.score > 0 && (
                    <Badge tone="accent">
                      <Star
                        aria-hidden
                        size="1em"
                        className="mr-0.5 inline align-[-0.125em]"
                        fill="currentColor"
                        strokeWidth={0}
                      />
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
function WatchBlock({ watch: w, onEdit, onGone }: { watch: Watch; onEdit: () => void; onGone?: () => void }) {
  const { t } = useTranslation()
  const act = useWatchActions()
  const {
    open: menuOpen,
    setOpen: setMenuOpen,
    ref: menuRef,
    anchor: menuAnchor,
    anchorStyle: menuAnchorStyle,
  } = useMenu()
  const total = w.media?.episodes ?? 0
  const pct = total > 0 ? (w.localFiles / total) * 100 : w.complete ? 100 : 0
  const canPlex = !!(w.plexAudioLang || w.plexSubLang)
  return (
    // min-w-0: a grid item's automatic minimum is its content's min-content
    // width, and the mono path would otherwise widen the sheet past a phone
    <section
      className="min-w-0 rounded-lg border border-border-subtle p-3"
      aria-label={watchTitle(w)}
      data-watch={w.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-t-muted" title={w.remotePath}>
          {w.serverName}:{w.remotePath} → {w.localPath}
        </p>
        <Button size="sm" onClick={() => act.check(w.id)}>
          <RefreshCw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('watch.checkNow')}
        </Button>
        <div className="relative" ref={menuRef} style={menuAnchorStyle}>
          <IconButton
            aria-label={t('watch.moreActions', { title: watchTitle(w) })}
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Ellipsis aria-hidden size="1.2em" />
          </IconButton>
          {menuOpen && (
            <Menu
              anchor={menuAnchor}
              placement="bottom-end"
              aria-label={t('watch.moreActions', { title: watchTitle(w) })}
            >
              <MenuItem
                onClick={() => {
                  setMenuOpen(false)
                  onEdit()
                }}
              >
                <Pencil aria-hidden size="1em" className="mr-2 inline align-[-0.125em]" />
                {t('servers.edit')}
              </MenuItem>
              {canPlex && (
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false)
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
                  setMenuOpen(false)
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
            {new Date(w.nextAiringAt * 1000).toLocaleString([], {
              weekday: 'short',
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
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
        {w.dubOverdue ? (
          <Badge tone="err" size="sm">
            <Clock aria-hidden size="1em" />
            {dubOverdueLabel(t, w)}
          </Badge>
        ) : w.dubWaiting ? (
          <Badge size="sm">
            <Clock aria-hidden size="1em" />
            {dubWaitingLabel(t, w)}
          </Badge>
        ) : (
          (w.langWaiting ?? 0) > 0 && (
            <Badge tone="warn" size="sm">
              <Clock aria-hidden size="1em" />
              {t('watch.langWaiting', { count: w.langWaiting, lang: langLabel(w) })}
            </Badge>
          )
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
        <Progress
          value={pct}
          size="sm"
          tone={w.complete ? 'ok' : 'accent'}
          label={t('series.progressLabel', { name: watchTitle(w) })}
          className="w-32"
        />
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
    </section>
  )
}
