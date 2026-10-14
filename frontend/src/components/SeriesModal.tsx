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
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { matchPath, useLocation, useNavigate, type Location } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ExternalLink, FolderOpen, Languages, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { Button, ButtonLink, IconButton, localTransition, markOverflow, useBackEntry } from 'fluid-lycoris'
import { api, mediaTitle, type Media, type MediaExtras, type Watch } from '../api'
import { coverSet } from '../images'
import { useNow } from '../hooks'
import ActionMenu from './ActionMenu'
import type { SheetAction } from './ActionSheet'
import MediaDetail, { mediaLink } from './MediaDetail'
import EpisodeList, { type EpisodeFolder, type EpisodeLanding } from './EpisodeList'
import Loading from './Loading'
import { filesLink, isVideo, playHref, viewHref, watchFolder } from './playLinks'
import { WatchForm } from './WatchDialog'
import { useWatchActions, watchFields } from './watchActions'
import { WatchExplain } from './WatchExplain'
import { CheckButton } from './CheckButton'
import { CoverImg } from './SmartImg'
import { Cast, Community, MatchSection, MoreWatches, Similar } from './SeriesSections'
import './series.css'

/** What a caller hands the series page: which title, and what it already knows. */
export interface SeriesTarget {
  /** anilist (default) | tmdb:tv | tmdb:movie */
  source?: string
  id: number
  /** the record the caller holds; the page fetches what is missing */
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
   * Folders the title's episodes lie in, for the episodes section: the
   * catalog's folder, a file's title folder. The title's own auto-sync
   * folders are added by the page.
   */
  folders?: EpisodeFolder[]
  /** a file to mark in the episodes section; the page opens there */
  playPath?: string
  /** an episode to land on (Neu da): scrolled to, its facts open, marked once */
  episode?: number
  season?: number
  /** open straight into the editor of the lead watch */
  edit?: boolean
  /** the title this one was opened from, for the "aus …" line */
  from?: string
  /**
   * What can be done with the title where the page was opened, for its
   * action row. Without any, a page with a watch offers checking and editing it.
   */
  actions?: SeriesAction[]
}

/** One action of the page's action row. */
export interface SeriesAction extends SheetAction {
  /** the one filled button */
  primary?: boolean
  /** a rare one, behind the ⋯ menu */
  more?: boolean
}

export type SeriesTab = 'overview' | 'episodes' | 'cast' | 'community' | 'similar'

interface SeriesModalApi {
  open: (target: SeriesTarget) => void
  close: () => void
}

const Ctx = createContext<SeriesModalApi | null>(null)

/** A form swapped into the page, as the provider knows it. */
interface View {
  close: () => void
  guard: () => Promise<boolean>
}
interface ViewApi {
  /** where a view renders: inside the page, in place of its content */
  host: HTMLElement | null
  attach: (v: View) => () => void
}
const ViewCtx = createContext<ViewApi | null>(null)

/** What a form shown in the page gets from it, to spread onto the form. */
export interface CardViewProps {
  /** the back arrow: asks the form's guard, then goes back to the page */
  onBack: () => void
  /** hands over the form's unsaved-changes check */
  onGuard: (check: () => Promise<boolean>) => void
  /** the slide in, on the routes' shared axis */
  className: string
}

/**
 * Shows a form inside the open series page instead of stacking a dialog on
 * it: the page's content steps aside for it and comes back when this
 * unmounts. The caller owns the form and its state, as with a dialog - it
 * renders this where it would have rendered the dialog, and drops it in
 * `onClose`, which the page also calls when it closes underneath. The back
 * gesture leaves the form first, past its guard.
 */
export function SeriesCardView({
  onClose,
  children,
}: {
  onClose: () => void
  children: (v: CardViewProps) => ReactNode
}) {
  const ctx = useContext(ViewCtx)
  if (!ctx) throw new Error('SeriesCardView outside SeriesModalProvider')
  const guard = useRef<() => Promise<boolean>>(async () => true)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })
  const { attach } = ctx
  useLayoutEffect(() => attach({ close: () => closeRef.current(), guard: () => guard.current() }), [attach])
  const close = useCallback(() => closeRef.current(), [])
  const ask = useCallback(() => guard.current(), [])
  useBackEntry(close, ask)
  const onBack = useCallback(async () => {
    if (await guard.current()) closeRef.current()
  }, [])
  const onGuard = useCallback((check: () => Promise<boolean>) => {
    guard.current = check
  }, [])
  if (!ctx.host) return null
  return createPortal(<ViewBody render={children} onBack={onBack} onGuard={onGuard} />, ctx.host)
}

function ViewBody({ render, ...v }: Omit<CardViewProps, 'className'> & { render: (v: CardViewProps) => ReactNode }) {
  return render({ ...v, className: 'anim-route-push' })
}

/** The back arrow at the head of a form shown in the page; focus starts there. */
export function BackToCard({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <IconButton aria-label={t('watch.backToCard')} title={t('watch.backToCard')} onClick={onClick} autoFocus>
      <ArrowLeft aria-hidden size="1.2em" />
    </IconButton>
  )
}

/** The one way to open the series page, from any cover in the app. */
export function useSeriesModal(): SeriesModalApi {
  const api = useContext(Ctx)
  if (!api) throw new Error('useSeriesModal outside SeriesModalProvider')
  return api
}

/**
 * Where an open page lives in history: it has a URL of its own
 * (/title/anilist/154587), shown in the address bar as a mask over the page
 * it was opened on, which stays the router's location underneath - so the
 * page keeps running behind it, and back closes it. The entry itself carries
 * only this; whatever the caller handed over that history cannot store (the
 * record, the extra rows, the actions) waits in `targets` under `k`, and a
 * reload, which loses that, makes the page fetch the record.
 */
interface TitleEntry {
  source: string
  id: number
  /** related titles opened on top of the first one: back is one of them */
  n: number
  k?: number
  /** the section to scroll to */
  tab?: SeriesTab
  /** an episode to land on (?ep=N, &s=S on a link) */
  ep?: number
  s?: number
  /** history index of the page under the series page, for closing in one step */
  bg?: number
  /** opened from a link: no page of its own underneath */
  direct?: boolean
}
export const TITLE_PATH = '/title/:source/:id'
const titleUrl = (e: TitleEntry) =>
  `/title/${e.source}/${e.id}${e.ep ? `?ep=${e.ep}${e.s !== undefined ? `&s=${e.s}` : ''}` : ''}`

function entryOf(loc: Location): TitleEntry | null {
  const e = (loc.state as { wsTitle?: TitleEntry } | null)?.wsTitle
  if (e) return e
  // a link straight to a page, or a reload of one: the dashboard stands behind
  const m = matchPath(TITLE_PATH, loc.pathname)
  const id = Number(m?.params.id)
  if (!m || !(id > 0)) return null
  const q = new URLSearchParams(loc.search)
  const ep = Number(q.get('ep')) || undefined
  const s = q.get('s') !== null ? Number(q.get('s')) : undefined
  return { source: m.params.source || 'anilist', id, n: 0, direct: true, ep, s, tab: ep ? 'episodes' : undefined }
}

// what open() was handed, by entry; a few dozen at most per session
// ponytail: never pruned, a Map of small objects until the tab closes
const targets = new Map<number, SeriesTarget>()
let seq = 0
const remember = (t: SeriesTarget) => {
  targets.set(++seq, { ...t, source: t.source || 'anilist' })
  return seq
}

const reducedMotion = () =>
  document.documentElement.dataset.motion === 'off' ||
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

/** What the page grew out of: a cover (into the page's cover) or a Heute banner panel (into the banner). */
interface Origin {
  el: HTMLElement
  kind: 'hero' | 'band'
}
const VT_NAME = { hero: 'ws-hero', band: 'band' } as const
const VT_TARGET = { hero: '.ws-d-cover', band: '.ws-d-banner' } as const

// Decode the pictures the first frame of the page shows before the morph
// starts, so its snapshot is not taken half painted; never longer than 180ms.
function decodeFirst(srcs: (string | undefined)[]) {
  const all = srcs
    .filter((s): s is string => !!s)
    .map((s) => {
      const img = new Image()
      img.src = s
      return img.decode ? img.decode().catch(() => {}) : Promise.resolve()
    })
  return Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, 180))])
}

/**
 * The morph between an origin on the page and its counterpart in the series
 * page: the two share a name for the transition, the rest of the series page
 * fades. No-op without view transitions (Firefox): the state still changes.
 */
function pairMorph(o: Origin, update: () => void, back = false) {
  const name = VT_NAME[o.kind]
  const named: HTMLElement[] = []
  const nameIt = (el: HTMLElement | null | undefined, n: string) => {
    if (!el) return
    el.style.viewTransitionName = n
    named.push(el)
  }
  const detailSide = () => {
    const d = document.querySelector<HTMLElement>('.ws-detail')
    nameIt(d, 'ws-detail')
    nameIt(d?.querySelector<HTMLElement>(VT_TARGET[o.kind]), name)
  }
  if (back) detailSide()
  else nameIt(o.el, name)
  return localTransition(null, () => {
    named.splice(0).forEach((el) => (el.style.viewTransitionName = ''))
    update()
    if (back) nameIt(o.el.isConnected ? o.el : null, name)
    else detailSide()
  }).finally(() => named.forEach((el) => (el.style.viewTransitionName = '')))
}

/**
 * Holds the series page the whole app shares. One page instead of one per
 * caller: a cover opens the same thing everywhere, and the page can grow
 * sections without every caller learning about them. A full-page overlay
 * over the content column; the sidebar and the tab bar stay, the page under
 * it is hidden while it is open. A route change closes it - the page belongs
 * to its history entry, and a page's own navigation leaves that entry behind.
 */
export function SeriesModalProvider({ children, panel }: { children: ReactNode; panel?: HTMLElement | null }) {
  const loc = useLocation()
  const nav = useNavigate()
  const entry = entryOf(loc)
  // closed by the user while the history step back is still under way:
  // gone at once, not one frame later
  const [closing, setClosing] = useState<string | null>(null)
  const shown = entry && closing !== loc.key ? entry : null
  // the handlers below run long after the render that made them (a caller
  // keeps open() in a closure), so they read the location from here
  const at = useRef(loc)
  useLayoutEffect(() => {
    at.current = loc
  })

  // The page grows out of what was clicked: a capture listener notes the
  // cover or Heute banner panel under the click just before the click
  // reaches the page's own handler.
  const lastOrigin = useRef<(Origin & { at: number }) | null>(null)
  useEffect(() => {
    const note = (e: Event) => {
      const t = e.target as HTMLElement | null
      const band = t?.closest?.<HTMLElement>('[data-band]')
      const cover = band ? null : t?.closest?.<HTMLElement>('.t-cover')
      const el = band ?? cover
      lastOrigin.current = el ? { el, kind: band ? 'band' : 'hero', at: performance.now() } : null
    }
    document.addEventListener('click', note, true)
    return () => document.removeEventListener('click', note, true)
  }, [])
  const [origin, setOrigin] = useState<Origin | null>(null)
  const opener = useRef<HTMLElement | null>(null)

  // a step in history that keeps the page and changes only the series page
  const go = useCallback(
    (e: TitleEntry, replace: boolean) => {
      const l = at.current
      return nav(
        { pathname: l.pathname, search: l.search, hash: l.hash },
        { state: { ...(l.state as object), wsTitle: e }, mask: titleUrl(e), replace, flushSync: true },
      )
    },
    [nav],
  )
  const view = useRef<View | null>(null)
  const open = useCallback(
    async (t: SeriesTarget) => {
      const from = lastOrigin.current
      lastOrigin.current = null
      const was = entryOf(at.current)
      // another title while the page is open swaps it in place, past the
      // guard of a form it may hold; back still closes the page
      if (was && view.current) {
        if (!(await view.current.guard())) return
        view.current.close()
      }
      const k = remember(t)
      const e: TitleEntry = {
        source: t.source || 'anilist',
        id: t.id,
        n: 0,
        k,
        tab: t.tab ?? (t.episode ? 'episodes' : undefined),
        ep: t.episode,
        s: t.season,
        bg: was ? was.bg : history.state?.idx,
        direct: was?.direct,
      }
      const fresh = from && from.el.isConnected && performance.now() - from.at < 500 ? from : null
      // the control that asked, unless that was inside the page itself
      const active = document.activeElement as HTMLElement | null
      opener.current =
        fresh?.el.closest<HTMLElement>('button, a, [tabindex]') ??
        (active?.closest('.ws-detail') ? opener.current : active)
      const o = !was ? fresh : null
      setOrigin(o ? { el: o.el, kind: o.kind } : null)
      if (o && typeof document.startViewTransition === 'function' && !reducedMotion()) {
        await decodeFirst([o.kind === 'band' ? t.media?.bannerImage : undefined, t.media?.coverImage?.large])
        void pairMorph(o, () => go(e, false))
      } else go(e, !!was)
    },
    [go],
  )
  // a related title is a step of its own: back returns to the one before
  const related = (t: SeriesTarget) => {
    const cur = entryOf(at.current)
    if (!cur) return
    go({ source: t.source || 'anilist', id: t.id, n: cur.n + 1, k: remember(t), bg: cur.bg, direct: cur.direct }, false)
  }
  const close = useCallback(() => {
    const l = at.current
    const e = entryOf(l)
    if (!e) return
    flushSync(() => {
      setClosing(l.key)
      view.current?.close()
    })
    // a link's page has nothing under it to go back to: the dashboard takes
    // its place. Otherwise back to the page, past every related title and
    // the entry of a form that was open - after that form took its own back
    // (useBackEntry), which is queued the same way.
    if (e.direct) return nav('/', { replace: true })
    // The step back waits for the next frame: the page is gone already, and
    // the router's render of the step would otherwise land in the frame a
    // closing morph snapshots (one long frame instead of two short ones).
    requestAnimationFrame(() =>
      setTimeout(() => {
        const idx = history.state?.idx
        const delta = typeof idx === 'number' && typeof e.bg === 'number' ? e.bg - idx : 0
        nav(delta < 0 ? delta : -(e.n + 1))
      }),
    )
  }, [nav])
  const api = useMemo(() => ({ open: (t: SeriesTarget) => void open(t), close }), [open, close])

  // The form shown in the page, if any. One at a time: a second replaces the
  // first. The page asks its guard before it closes, and closes it with it.
  const [viewOn, setViewOn] = useState(false)
  const [host, setHost] = useState<HTMLElement | null>(null)
  // the page notes its scroll and focus here before its content steps aside
  const away = useRef<() => void>(() => {})
  const attach = useCallback((v: View) => {
    away.current()
    view.current = v
    setViewOn(true)
    return () => {
      if (view.current !== v) return
      view.current = null
      setViewOn(false)
    }
  }, [])
  const views = useMemo(() => ({ host, attach }), [host, attach])
  // the page went (back gesture, a route change): its form goes with it
  useEffect(() => {
    if (!shown) view.current?.close()
  }, [shown])

  // While the page is open the view under it is hidden (shell rule on
  // html[data-overlay]); focus goes back to what opened it on the way out.
  const isOpen = !!shown
  useEffect(() => {
    if (!isOpen) return
    const root = document.documentElement
    root.dataset.overlay = 'series'
    return () => {
      delete root.dataset.overlay
      const back = opener.current
      if (back?.isConnected) requestAnimationFrame(() => back.focus({ preventScroll: true }))
    }
  }, [isOpen])

  // a docked panel beside <main> (the transfers) narrows the page: its width
  // as a variable the overlay's right edge reads
  useEffect(() => {
    if (!panel || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const set = () => {
      let w = 0
      for (const c of panel.children) w += (c as HTMLElement).getBoundingClientRect().width
      root.style.setProperty('--ws-aside-w', `${w}px`)
    }
    const ro = new ResizeObserver(set)
    const watch = () => {
      ro.disconnect()
      for (const c of panel.children) ro.observe(c)
      set()
    }
    const mo = new MutationObserver(watch)
    mo.observe(panel, { childList: true })
    watch()
    return () => {
      ro.disconnect()
      mo.disconnect()
      root.style.removeProperty('--ws-aside-w')
    }
  }, [panel])

  const target: SeriesTarget | null = shown
    ? {
        ...((shown.k && targets.get(shown.k)) || {
          id: shown.id,
          // an entry from before the auto-sync section went into the episodes still says 'sync'
          tab: (shown.tab as string) === 'sync' ? 'episodes' : shown.tab,
        }),
        source: shown.source,
        id: shown.id,
      }
    : null
  return (
    <Ctx.Provider value={api}>
      <ViewCtx.Provider value={views}>
        {children}
        {shown &&
          target &&
          createPortal(
            <SeriesCard
              key={`${shown.k}:${shown.source}:${shown.id}`}
              entry={shown}
              target={target}
              origin={origin}
              onClose={close}
              onRelated={related}
              onBack={() => nav(-1)}
              viewOn={viewOn}
              viewHost={setHost}
              viewGuard={() => view.current?.guard() ?? Promise.resolve(true)}
              viewClose={() => view.current?.close()}
              away={away}
            />,
            document.body,
          )}
      </ViewCtx.Provider>
    </Ctx.Provider>
  )
}

// the order the sections stand in on the one scrolling page
const SECTIONS: SeriesTab[] = ['overview', 'episodes', 'cast', 'similar', 'community']

interface CardProps {
  entry: TitleEntry
  target: SeriesTarget
  /** what the page grew out of, to shrink back into */
  origin: Origin | null
  onClose: () => void
  onRelated: (t: SeriesTarget) => void
  /** to the related title before this one */
  onBack: () => void
  /** a form is shown in place of the content (SeriesCardView) */
  viewOn: boolean
  viewHost: (el: HTMLElement | null) => void
  viewGuard: () => Promise<boolean>
  viewClose: () => void
  away: { current: () => void }
}

function SeriesCard({
  entry,
  target: cur,
  origin,
  onClose,
  onRelated,
  onBack,
  viewOn,
  viewHost,
  viewGuard,
  viewClose,
  away: noteAway,
}: CardProps) {
  const { t } = useTranslation()
  const source = cur.source || 'anilist'
  const goTo = useNavigate()

  // Rendered in steps, so the first frame (the one a morph snapshots) is the
  // head alone: the episodes and the sync explanation follow a frame later
  // and rise in, cast, similar titles and the community once the morph is over.
  const [stage, setStage] = useState(0)
  useEffect(() => {
    let a = 0
    const t1 = { id: 0 as ReturnType<typeof setTimeout> | 0 }
    const t2 = { id: 0 as ReturnType<typeof setTimeout> | 0 }
    a = requestAnimationFrame(() => {
      t1.id = setTimeout(() => setStage(1), 60)
      t2.id = setTimeout(() => setStage(2), 540)
    })
    return () => {
      cancelAnimationFrame(a)
      if (t1.id) clearTimeout(t1.id)
      if (t2.id) clearTimeout(t2.id)
    }
  }, [])

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
  // The banner: AniList's own (the picture a Heute panel morphs from), else
  // the TMDB backdrop the id mapping knows.
  const { data: backdrop } = useQuery<{ url: string; large: string }>({
    queryKey: ['backdrop', cur.id],
    queryFn: () => api.get(`/api/media/backdrop?id=${cur.id}`),
    enabled: source === 'anilist' && !!media && !media.bannerImage && stage > 0,
    staleTime: 24 * 60 * 60_000,
  })
  const art = media?.bannerImage || backdrop?.url
  const big = !media?.bannerImage && backdrop?.large ? backdrop.large : ''
  const artSet = big ? `${art} 1280w, ${big} 3840w` : undefined

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
  const lead = mine[0]
  const ownedIds = useMemo(() => new Set(watches.map((w) => w.media?.id ?? 0)), [watches])

  // where the title's episodes lie: what the caller knows (the catalog's
  // folder) and the local folder of every watch, once each
  const folders: EpisodeFolder[] = []
  for (const f of [...(cur.folders ?? []), ...mine.map((w) => ({ server: 0, path: watchFolder(w) }))]) {
    if (f.path && !folders.some((g) => g.server === f.server && g.path === f.path)) folders.push(f)
  }
  // a play button opens the player; the page stays in history behind it, so
  // back from the player returns here. A manga's volumes open in the reader.
  const play = (server: number, path: string) => goTo(isVideo(path) ? playHref(server, path) : viewHref(server, path))

  const sections = SECTIONS.filter((k) => k !== 'episodes' || mine.length > 0 || folders.length > 0)
  const ids = useId()
  const hid = (k: string) => `${ids}-${k}-h`
  const name = cur.title || (media ? mediaTitle(media) : '')
  const now = useNow()

  // A form - editing a watch here, syncing or matching from the caller -
  // replaces the page's content rather than stacking a dialog on it. The
  // content unmounts while it is away, so where it was scrolled to and which
  // control asked are kept for the way back.
  const act = useWatchActions()
  const [editing, setEditing] = useState<Watch | null>(null)
  const away = useRef<{ top: number; focus: string } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const note = (focus: string) => {
    away.current ??= { top: scroller.current?.scrollTop ?? 0, focus }
  }
  noteAway.current = () => {
    const key = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-action]')?.dataset.action
    note(key ? `[data-action="${key}"]` : '')
  }
  const edit = (w: Watch, focus = '[data-action="edit"]') => {
    note(focus)
    setEditing(w)
  }
  // opened straight into the editor (the watch list's "edit")
  const editAsked = useRef(!!cur.edit)
  useEffect(() => {
    if (!editAsked.current || !lead) return
    editAsked.current = false
    setEditing(lead)
  }, [lead])

  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined' || !!cur.tab)
  const { data: extras, isError: extrasFailed } = useQuery<MediaExtras>({
    queryKey: ['media-extras', source, cur.id],
    queryFn: () => api.get(`/api/media/extras?source=${source}&id=${cur.id}`),
    enabled: near && stage > 1,
    staleTime: 5 * 60_000,
    retry: false,
  })

  // the menu of a watch: everything but check now and edit, which are buttons
  const watchMenu = (w: Watch): SheetAction[] => [
    ...(w.plexAudioLang || w.plexSubLang
      ? [
          {
            key: 'plex',
            label: t('watch.plexApplyAll'),
            icon: <Languages aria-hidden size="1em" />,
            onClick: () => void act.applyPlexStreams(w.id),
          },
        ]
      : []),
    ...((w.missing?.length ?? 0) > 0
      ? [
          {
            key: 'gaps',
            label: t('series.fillGaps'),
            icon: <RefreshCw aria-hidden size="1em" />,
            onClick: () => void act.check(w.id),
          },
        ]
      : []),
    {
      key: 'files',
      label: t('series.showInFiles'),
      icon: <FolderOpen aria-hidden size="1em" />,
      onClick: () => goTo(filesLink(0, watchFolder(w))),
    },
    ...(w !== lead
      ? [
          {
            key: 'edit',
            label: t('servers.edit'),
            icon: <Pencil aria-hidden size="1em" />,
            onClick: () => edit(w, `[data-watch="${w.id}"] [aria-haspopup]`),
          },
        ]
      : []),
    {
      key: 'delete',
      label: t('series.deleteWatch'),
      icon: <Trash2 aria-hidden size="1em" />,
      danger: true,
      onClick: () => void act.del(w).then((gone) => gone && mine.length === 1 && onClose()),
    },
  ]
  const own = media ? mediaLink(source, media.id) : null
  const callerActions = cur.actions ?? []
  const menu: SheetAction[] = [
    ...(lead ? watchMenu(lead) : []),
    ...callerActions.filter((a) => a.more),
    ...(own && lead
      ? [
          {
            key: 'provider',
            label: t('series.openAt', { site: own.label }),
            icon: <ExternalLink aria-hidden size="1em" />,
            onClick: () => window.open(own.href, '_blank', 'noreferrer'),
          },
        ]
      : []),
  ]

  // the banner's lag and the docked title, written straight to the elements:
  // a state update per scroll frame would re-render the whole page
  const bannerArt = useRef<HTMLSpanElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const frame = useRef(0)
  const onScroll = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const b = bannerArt.current
      if (!b || reducedMotion()) return
      const y = Math.min(Math.max(scroller.current?.scrollTop ?? 0, 0), 320)
      b.style.transform = y ? `translateY(${y * 0.34}px) scale(${1 + y * 0.0002})` : ''
      b.style.opacity = y ? String(0.5 - (y / 320) * 0.3) : ''
    })
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  // What reads sizes or moves focus waits a frame after the commit: an
  // opening page commits inside the morph's update callback, where a size
  // read or focus() forces the whole new page through style and layout
  // while the view under it is still restyling (twice the work, in the one
  // frame the morph snapshots).
  useEffect(() => {
    const root = scroller.current
    const h = title.current
    if (!root || !h || typeof IntersectionObserver === 'undefined') return
    let io: IntersectionObserver | undefined
    const id = requestAnimationFrame(() => {
      const bar = root.querySelector<HTMLElement>('.ws-d-bar')?.offsetHeight ?? 52
      io = new IntersectionObserver(
        ([e]) => root.toggleAttribute('data-docked', !e.isIntersecting && (e.boundingClientRect?.top ?? 0) < bar + 30),
        { root, rootMargin: `-${bar}px 0px 0px 0px` },
      )
      io.observe(h)
    })
    return () => {
      cancelAnimationFrame(id)
      io?.disconnect()
    }
  }, [viewOn])

  // focus moves into the page as it opens: the page under it is hidden
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = scroller.current
      // a section the page jumped to in the meantime keeps its focus
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(id)
  }, [])

  // The jump row marks the section being read (aria-current): the first one
  // inside a band from under the sticky rows to the middle of the page. A
  // second observer watches the first lazy section come within a screen.
  const sec = useRef<Partial<Record<SeriesTab, HTMLElement | null>>>({})
  const [current, setCurrent] = useState<SeriesTab>('overview')
  const jumpLock = useRef(0)
  const sticky = () => {
    const root = scroller.current
    return (
      (root?.querySelector<HTMLElement>('.ws-d-bar')?.offsetHeight ?? 52) +
      (root?.querySelector<HTMLElement>('.ws-d-jump')?.offsetHeight ?? 44) +
      8
    )
  }
  useEffect(() => {
    const root = scroller.current
    if (!root || viewOn || typeof IntersectionObserver === 'undefined') return
    const seen = new Map<Element, boolean>()
    // of the sections in the band, the last one whose top has passed under
    // the sticky rows; a short section's tail must not outvote it
    const readNow = () => {
      const inBand = sections.filter((k) => seen.get(sec.current[k]!))
      const line = root.getBoundingClientRect().top + sticky() + 1
      const passed = inBand.filter((k) => sec.current[k]!.getBoundingClientRect().top <= line)
      return passed.length ? passed[passed.length - 1] : inBand[0]
    }
    let spy: IntersectionObserver | undefined
    let ahead: IntersectionObserver | undefined
    const id = requestAnimationFrame(() => {
      const s = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => seen.set(e.target, e.isIntersecting))
          // a jump holds its mark while the page glides there
          if (performance.now() < jumpLock.current) return
          // scrolled to the end, the last section is the one being read even
          // though a short one never reaches the top of the band
          const end = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2
          const first = end ? sections[sections.length - 1] : root.scrollTop < 2 ? sections[0] : readNow()
          if (first) setCurrent(first)
        },
        { root, rootMargin: `-${sticky()}px 0px -55% 0px` },
      )
      const a = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), {
        root,
        rootMargin: '0px 0px 100% 0px',
      })
      sections.forEach((k) => sec.current[k] && s.observe(sec.current[k]))
      if (sec.current.cast) a.observe(sec.current.cast)
      spy = s
      ahead = a
    })
    return () => {
      cancelAnimationFrame(id)
      spy?.disconnect()
      ahead?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections.join(), viewOn, cur.id])

  // On a phone the jump row is wider than the screen: the marked entry slides
  // to the middle, sideways only (scrollIntoView would move the page too)
  const tabRow = useRef<HTMLElement>(null)
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const row = tabRow.current
      const a = row?.querySelector<HTMLElement>('[aria-current="true"]')
      if (!row || !a) return
      row.scrollTo?.({
        left: a.offsetLeft - (row.clientWidth - a.offsetWidth) / 2,
        behavior: reducedMotion() ? 'auto' : 'smooth',
      })
      markOverflow(row)
    })
    return () => cancelAnimationFrame(id)
  }, [current, sections.length])

  const jump = (k: SeriesTab, smooth = true) => {
    const el = sec.current[k]
    const sc = scroller.current
    if (!el || !sc) return
    setCurrent(k)
    jumpLock.current = smooth && !reducedMotion() ? performance.now() + 900 : 0
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - sticky()
    sc.scrollTo?.({ top, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' })
    // a keyboard user lands in the section, not back at the top of the row
    el.focus({ preventScroll: true })
  }
  // The caller's section: jumped to once it exists - a watch's episodes
  // appear with the watch list - and dropped if the list arrives without it.
  // A landing on an episode scrolls the episode itself (EpisodeList).
  const pending = useRef<SeriesTab | null>(cur.tab && cur.tab !== 'overview' && !entry.ep ? cur.tab : null)
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
    if (viewOn || !was) return
    away.current = null
    if (scroller.current) scroller.current.scrollTop = was.top
    if (was.focus) scroller.current?.querySelector<HTMLElement>(was.focus)?.focus()
  }, [viewOn])

  // back: out of the editor (past its guard), to the title before, or out
  const leave = () => (origin?.el.isConnected ? void pairMorph(origin, onClose, true) : onClose())
  const back = async () => {
    if (viewOn) {
      if (await viewGuard()) viewClose()
      return
    }
    if (entry.n > 0) onBack()
    else leave()
  }

  const land: EpisodeLanding | undefined = entry.ep
    ? { ep: entry.ep, season: entry.s }
    : cur.episode
      ? { ep: cur.episode, season: cur.season }
      : undefined
  const streamSite = (extras?.links ?? media?.externalLinks ?? []).find((l) => l.type === 'STREAMING')?.site
  const english = media?.title.english
  const meta = [
    english && english !== name && !/[぀-ヿ㐀-鿿]/.test(english) ? english : '',
    media?.seasonYear ? String(media.seasonYear) : '',
    media?.studios?.[0] ?? '',
    streamSite ?? '',
  ].filter(Boolean)

  return (
    <>
      {editing && (
        <SeriesCardView onClose={() => setEditing(null)}>
          {(v) => (
            <WatchForm
              {...v}
              title={t('watch.editTitle')}
              serverId={editing.serverId}
              watchId={editing.id}
              initial={watchFields(editing)}
              onSave={(f) => act.save(editing.id, f)}
              onClose={() => setEditing(null)}
            />
          )}
        </SeriesCardView>
      )}
      <div
        ref={scroller}
        className="ws-detail"
        role="dialog"
        aria-modal="false"
        aria-label={name}
        tabIndex={-1}
        data-editing={viewOn || undefined}
        onScroll={onScroll}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || e.defaultPrevented) return
          e.preventDefault()
          void back()
        }}
      >
        <div className="ws-d-bar">
          <IconButton aria-label={t('series.backLabel')} title={t('series.backLabel')} onClick={() => void back()}>
            <ArrowLeft aria-hidden size="1.25rem" />
          </IconButton>
          <span className="ws-d-bar-t" aria-hidden>
            {viewOn ? t('watch.editTitle') : name}
          </span>
        </div>
        {viewOn ? (
          <div ref={viewHost} className="ws-d-edit" />
        ) : (
          <>
            <div className="ws-d-banner" aria-hidden>
              {art && (
                <span ref={bannerArt} className="ws-d-banner-art">
                  <img
                    src={art}
                    srcSet={artSet}
                    sizes={artSet ? '100vw' : undefined}
                    alt=""
                    fetchPriority="high"
                    decoding="async"
                  />
                </span>
              )}
            </div>
            <header
              className="ws-d-hero"
              style={media?.coverImage?.color ? ({ '--d-tint': media.coverImage.color } as CSSProperties) : undefined}
            >
              <CoverImg
                className="ws-d-cover"
                set={coverSet(media?.coverImage)}
                tint={media?.coverImage?.color}
                title={name}
                sizes="(min-width: 64rem) 10.5rem, 7rem"
                eager
                priority
              />
              <div className="ws-d-head">
                {entry.n > 0 && cur.from && <p className="ws-d-crumb">{t('series.from', { title: cur.from })}</p>}
                <h1 ref={title} className="ws-d-title">
                  {name}
                </h1>
                {meta.length > 0 && <p className="ws-d-meta">{meta.join(' · ')}</p>}
              </div>
              <div className="ws-d-acts">
                {lead && (
                  <span data-action="check" className="contents">
                    <CheckButton watchId={lead.id} act={act} />
                  </span>
                )}
                {lead && (
                  <Button size="sm" data-action="edit" onClick={() => edit(lead)}>
                    <Pencil aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                    {t('servers.edit')}
                  </Button>
                )}
                {callerActions
                  .filter((a) => !a.more)
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
                {!lead && !callerActions.some((a) => !a.more) && own && (
                  <ButtonLink size="sm" href={own.href} target="_blank" rel="noreferrer">
                    {own.label}
                    <ExternalLink aria-hidden size="1em" className="ml-1 inline align-[-0.125em]" />
                  </ButtonLink>
                )}
                <ActionMenu label={t('series.moreActions', { name })} title={name} actions={menu} />
                {act.error && (
                  <p className="ws-d-err basis-full" role="status">
                    {act.error}
                  </p>
                )}
              </div>
            </header>
            <nav
              ref={tabRow}
              className="ws-d-jump"
              aria-label={t('series.sectionsLabel')}
              onScroll={(e) => markOverflow(e.currentTarget)}
            >
              {sections.map((k) => (
                <a
                  key={k}
                  href={`#${ids}-${k}`}
                  aria-current={current === k ? 'true' : undefined}
                  onClick={(e) => {
                    e.preventDefault()
                    jump(k)
                  }}
                >
                  {t(`series.tab.${k}`)}
                </a>
              ))}
            </nav>
            <div className="ws-d-body">
              {lead && stage > 0 && (
                <div className="ws-d-aside ws-d-late">
                  {(lead.missing?.length ?? 0) > 0 && (
                    <CheckButton
                      watchId={lead.id}
                      act={act}
                      variant="sync"
                      label={t('series.sync.load', { count: lead.missing!.length })}
                    />
                  )}
                  <WatchExplain watch={lead} now={now} />
                  <MatchSection watch={lead} />
                  <MoreWatches watches={mine.slice(1)} menu={watchMenu} />
                </div>
              )}
              <div className="ws-d-main">
                {sections.map((k) => (
                  <section
                    key={k}
                    id={`${ids}-${k}`}
                    ref={(el) => {
                      sec.current[k] = el
                    }}
                    tabIndex={-1}
                    aria-labelledby={hid(k)}
                    className="ws-d-sec"
                  >
                    {k === 'overview' && (
                      <>
                        <h2 id={hid(k)} className="sr-only">
                          {t('series.tab.overview')}
                        </h2>
                        {/* not in the morph's first frame: only the head morphs */}
                        {media && stage > 0 && (
                          <MediaDetail
                            media={media}
                            source={source}
                            airings={lead?.airings}
                            links={extras?.links}
                            now={now}
                          >
                            {cur.extra}
                          </MediaDetail>
                        )}
                      </>
                    )}
                    {k === 'episodes' &&
                      (stage > 0 ? (
                        <div className="ws-d-late">
                          <EpisodeList
                            folders={folders}
                            watches={mine}
                            highlight={cur.playPath}
                            land={land}
                            onPlay={play}
                            now={now}
                            headingId={hid(k)}
                          />
                        </div>
                      ) : (
                        <>
                          <h2 id={hid(k)} className="sr-only">
                            {t('series.tab.episodes')}
                          </h2>
                          <Loading />
                        </>
                      ))}
                    {k === 'cast' &&
                      (stage > 1 ? (
                        <div className="ws-d-late">
                          <Cast extras={extras} failed={extrasFailed} source={source} headingId={hid(k)} />
                        </div>
                      ) : (
                        <h2 id={hid(k)} className="sr-only">
                          {t('series.tab.cast')}
                        </h2>
                      ))}
                    {k === 'similar' &&
                      (stage > 1 ? (
                        <div className="ws-d-late">
                          <Similar
                            extras={extras}
                            failed={extrasFailed}
                            source={source}
                            owned={ownedIds}
                            headingId={hid(k)}
                            onPick={(m, _label, same) =>
                              onRelated({ source: same ? source : 'anilist', id: m.id, media: m, from: name })
                            }
                          />
                        </div>
                      ) : (
                        <h2 id={hid(k)} className="sr-only">
                          {t('series.tab.similar')}
                        </h2>
                      ))}
                    {k === 'community' &&
                      (stage > 1 && near ? (
                        <div className="ws-d-late">
                          <Community
                            source={source}
                            id={cur.id}
                            threads={extras?.threads}
                            failed={extrasFailed}
                            headingId={hid(k)}
                          />
                        </div>
                      ) : (
                        <h2 id={hid(k)} className="sr-only">
                          {t('series.tab.community')}
                        </h2>
                      ))}
                  </section>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}
