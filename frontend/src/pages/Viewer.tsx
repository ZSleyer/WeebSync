import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import {
  ArrowLeft,
  ArrowLeftRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  GalleryVertical,
  LayoutGrid,
  List,
  Maximize,
  Minimize,
  MoveHorizontal,
  MoveVertical,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react'
import { buttonClass, Dialog, EmptyState, Segmented } from 'fluid-lycoris'
import { api, type Entry } from '../api'
import Loading from '../components/Loading'
import { AudioPanel, useAudio } from '../components/AudioPlayer'
import { useImmersive } from '../components/useImmersive'
import { useStored } from '../hooks/useStored'
import Markdown from '../components/Markdown'
import {
  catalogTitle,
  doneKey,
  filesLink,
  isBook,
  listFolder,
  streamUrl,
  useBack,
  viewHref,
  viewKind,
  type ViewKind,
} from '../components/playLinks'
import {
  decodeText,
  epubRootfile,
  epubSpine,
  epubToc,
  odsSheets,
  xlsxRows,
  xlsxSheetParts,
  xlsxStrings,
  type EpubChapter,
  type Sheet,
} from '../components/bookParse'
import { clampTo, dragOutcome, lookedUrl, READER_THEMES, volumeOf, type BookLook, type ReaderTheme } from './readerUtil'
import './reader.css'

// pdf.js is a megabyte nobody but a PDF needs
const PdfView = lazy(() => import('./ViewerPdf'))

/** What /api/read/open hands back: where the unpacked pieces are served. */
export interface ReaderBook {
  base: string
  kind: 'comic' | 'epub' | 'sheet'
  pages?: string[]
}

const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { numeric: true })
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
const stem = (name: string) => name.replace(/\.[^.]+$/, '')
// a piece of an unpacked book; every segment escaped, the slashes kept
export const bookUrl = (base: string, p: string) => base + p.split('/').map(encodeURIComponent).join('/')

// the route: every file gets a fresh viewer, so nothing of one leaks into the next
export default function Viewer() {
  const [params] = useSearchParams()
  const server = Number(params.get('server') || 0)
  const path = params.get('path') || ''
  return <ViewerView key={`${server}:${path}`} server={server} path={path} />
}

function ViewerView({ server, path }: { server: number; path: string }) {
  const { t } = useTranslation()
  const name = path.split('/').pop() || path
  const kind = viewKind(name)
  if (!path || !kind) return <EmptyState>{t('viewer.unsupported')}</EmptyState>
  // a song plays in the app's one audio element and keeps the shell around it
  if (kind === 'audio') return <AudioView server={server} path={path} />
  return (
    <ReaderFrame server={server} path={path} title={stem(name)} themed={kind === 'epub'}>
      <Body kind={kind} server={server} path={path} />
    </ReaderFrame>
  )
}

function Body({ kind, server, path }: { kind: Exclude<ViewKind, 'audio'>; server: number; path: string }) {
  switch (kind) {
    case 'comic':
    case 'epub':
    case 'sheet':
      return <BookView server={server} path={path} />
    case 'pdf':
      return (
        <Suspense fallback={<ReaderState loading />}>
          <PdfView server={server} path={path} />
        </Suspense>
      )
    case 'image':
      return <ImageView server={server} path={path} />
    case 'text':
      return <TextView server={server} path={path} />
  }
}

// ---- the frame: full screen, floating bars that step aside ----

interface Frame {
  /** the bars are showing */
  chrome: boolean
  /** the middle tap: show or hide the bars */
  toggle: () => void
  /** a tool was used: the bars stay a while longer */
  poke: () => void
  /** keep the bars this long without stepping aside, or never (for views without tap zones) */
  setAutohide: (on: boolean) => void
  /** the line under the title and the right end of the top bar, filled by the view inside */
  sub: HTMLElement | null
  slot: HTMLElement | null
  theme: ReaderTheme
  setTheme: (t: ReaderTheme) => void
  /** back to where the reader came from */
  close: () => void
}
const FrameCtx = createContext<Frame | null>(null)
const useFrame = () => {
  const f = useContext(FrameCtx)
  if (!f) throw new Error('useFrame outside ReaderFrame')
  return f
}

/** How long the bars stay after the last touch. */
const AUTOHIDE_MS = 3500

/**
 * The reader's frame: an overlay over the whole app on a phone (the shell's
 * bars step aside under html.reading), beside the sidebar on a desktop. The
 * top bar holds the way back, the title and what the view adds; the bars
 * fade out after a while and a tap in the middle of the page brings them
 * back. Keyboard focus moving into a bar shows it too.
 */
function ReaderFrame({
  server,
  path,
  title,
  themed,
  children,
}: {
  server: number
  path: string
  title: string
  /** an EPUB takes the chosen background; everything else reads on black */
  themed: boolean
  children: ReactNode
}) {
  const { t } = useTranslation()
  useImmersive('reading')
  const close = useBack(filesLink(server, parentOf(path)))
  const root = useRef<HTMLDivElement>(null)
  const bars = useRef<HTMLDivElement>(null)
  const [chrome, setChrome] = useState(true)
  const [autohide, setAutohide] = useState(true)
  const [poked, setPoked] = useState(0)
  const [sub, setSub] = useState<HTMLElement | null>(null)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [stored, setStored] = useStored<string>('viewer.rdtheme', 'dark')
  const theme: ReaderTheme = (READER_THEMES as readonly string[]).includes(stored) ? (stored as ReaderTheme) : 'dark'
  const [full, setFull] = useState(false)

  // the bars step aside after a while, unless something in them is in use:
  // a keyboard focus, the pointer over them, an open sheet
  useEffect(() => {
    if (!chrome || !autohide) return
    const id = setTimeout(() => {
      const busy =
        bars.current?.matches(':hover') ||
        (bars.current?.contains(document.activeElement) && document.activeElement?.matches(':focus-visible')) ||
        document.querySelector('dialog[open]')
      if (busy) setPoked((n) => n + 1)
      else setChrome(false)
    }, AUTOHIDE_MS)
    return () => clearTimeout(id)
  }, [chrome, autohide, poked])

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === root.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else root.current?.requestFullscreen?.().catch(() => {})
  }

  const frame: Frame = {
    chrome,
    toggle: () => {
      setChrome((c) => !c)
      setPoked((n) => n + 1)
    },
    poke: () => setPoked((n) => n + 1),
    setAutohide: (on) => {
      setAutohide(on)
      if (!on) setChrome(true)
    },
    sub,
    slot,
    theme,
    setTheme: setStored,
    close,
  }
  return (
    // the value carries the bars' state, which changes with every tap anyway
    // eslint-disable-next-line react/jsx-no-constructed-context-values
    <FrameCtx.Provider value={frame}>
      <div
        ref={root}
        className="ws-rd"
        data-rdtheme={themed ? theme : undefined}
        data-chrome={chrome ? '' : undefined}
        onFocus={(e) => {
          // a Tab into a hidden bar shows it
          if (bars.current?.contains(e.target) || (e.target as HTMLElement).closest?.('.ws-rd-bottom')) {
            setChrome(true)
            setPoked((n) => n + 1)
          }
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || e.defaultPrevented || document.fullscreenElement) return
          e.preventDefault()
          close()
        }}
      >
        {children}
        <div ref={bars} className="ws-rd-top">
          <button
            type="button"
            className="ws-rd-ic"
            aria-label={t('reader.back')}
            title={t('reader.back')}
            onClick={close}
          >
            <ArrowLeft aria-hidden />
          </button>
          <div className="ws-rd-title">
            <b title={path}>{title}</b>
            <span ref={setSub} />
          </div>
          <span ref={setSlot} className="ws-rd-slot" />
          {document.fullscreenEnabled && (
            <button
              type="button"
              className="ws-rd-ic"
              aria-label={t('viewer.fullscreen')}
              title={t('viewer.fullscreen')}
              aria-pressed={full}
              onClick={fullscreen}
            >
              {full ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
            </button>
          )}
        </div>
      </div>
    </FrameCtx.Provider>
  )
}

/** The line under the reader's title ("Band 5 · Seite 3 von 14"). */
function FrameSub({ children }: { children: ReactNode }) {
  const { sub } = useFrame()
  return sub ? createPortal(children, sub) : null
}

/** Buttons for the right end of the reader's top bar. */
function FrameTools({ children }: { children: ReactNode }) {
  const { slot } = useFrame()
  return slot ? createPortal(children, slot) : null
}

/** A loading line or an error in the middle of the reader. */
function ReaderState({ loading, error, label }: { loading?: boolean; error?: unknown; label?: string }) {
  const { t } = useTranslation()
  return (
    <div className="ws-rd-state">
      {loading ? (
        <Loading size="lg" label={label} />
      ) : (
        <p role="alert">
          {t('viewer.loadError')} {error instanceof Error ? error.message : ''}
        </p>
      )}
    </div>
  )
}

/**
 * A bottom sheet on a phone, a dialog on a desktop: the reader's page
 * thumbnails, contents and type settings. Rendered at the body, so it takes
 * the app's colours rather than the reader's.
 */
function ReaderSheet({
  title,
  onClose,
  wide,
  children,
}: {
  title: string
  onClose: () => void
  wide?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation()
  return createPortal(
    <Dialog width={wide ? 'max-w-3xl' : 'max-w-lg'} sheet aria-label={title} onClose={onClose}>
      <div className="dialog-body w-full bg-bg-card">
        <div className="ws-rd-sh-hd">
          <h2>{title}</h2>
          <button
            type="button"
            className="t-iconbtn"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={onClose}
          >
            <X aria-hidden size="1.1em" />
          </button>
        </div>
        <div className="ws-rd-sh t-scroll min-h-0">{children}</div>
      </div>
    </Dialog>,
    document.body,
  )
}

// ---- paged reading: comics, PDFs, a folder of pictures ----

export type PageLayout = 'single' | 'double' | 'scroll'

// a spread opens on an odd page: the cover stands alone, then 1+2, 3+4 …
export const spreadOf = (p: number) => (p === 0 ? 0 : p - ((p - 1) % 2))

const HINT_KEY = 'viewer.hinted'
/** the first open on this device explains the taps, once */
const firstOpen = () => {
  try {
    if (localStorage.getItem(HINT_KEY)) return false
    localStorage.setItem(HINT_KEY, '1')
    return true
  } catch {
    return false
  }
}

/** What follows the last page: the next volume of the folder, the cover of the title. */
export interface PagedEnd {
  /** this volume's number, from its file name */
  volume?: number | null
  next?: NextBook
  cover?: string
}

/**
 * One page at a time, two side by side, or the whole book as one long strip
 * the way a webtoon reads. Pages turn by a drag that follows the finger, a
 * tap on the outer edges, the arrow keys or the slider; right to left
 * reverses all of it, the way a manga reads. The page shown is remembered
 * per file; past the last one the end of the volume offers the next.
 */
export function Paged({
  count,
  page: pageKey,
  initial = 0,
  direction,
  kind,
  render,
  preload,
  thumb,
  label,
  done,
  end,
}: {
  count: number
  /** storage key for the reading position; empty = not remembered */
  page: string
  initial?: number
  /**
   * How the pages read until the user turns it around: a manga right to left,
   * a PDF or a folder of pictures the western way. Each keeps its own
   * setting, so a manga read backwards never turns the next PDF around.
   */
  direction: 'manga' | 'western'
  /** a PDF's pages get a shadow and open fitted to the width */
  kind?: 'pdf'
  render: (i: number, fit: 'width' | 'height') => ReactNode
  preload?: (i: number) => void
  /** a small picture of a page for the overview; without it the overview lists numbers */
  thumb?: (i: number) => string
  label: string
  /** storage key set once the last page was shown: the volume is read */
  done?: string
  end?: PagedEnd
}) {
  const { t } = useTranslation()
  const frame = useFrame()
  const [stored, setStored] = useStored<number>(pageKey || 'viewer.none', initial)
  const [local, setLocal] = useState(initial)
  const page = Math.min(Math.max(pageKey ? stored : local, 0), Math.max(count - 1, 0))
  const setPage = (i: number) => (pageKey ? setStored(i) : setLocal(i))
  const [rtl, setRtl] = useStored<string>(`viewer.rtl.${direction}`, direction === 'manga' ? '1' : '0')
  // kept per kind: a PDF reads fitted to the width, a comic page to the height
  const [fit, setFit] = useStored<'width' | 'height'>(
    `viewer.fit.${kind ?? direction}`,
    kind === 'pdf' ? 'width' : 'height',
  )
  // kept per direction like the reading way: a manga in spreads leaves the PDFs alone
  const [layout, setLayout] = useStored<PageLayout>(`viewer.layout.${direction}`, 'single')
  const [overview, setOverview] = useState(false)
  // past the last page: the end of the volume stands in for a page
  const [ended, setEnded] = useState(false)
  const [hint] = useState(firstOpen)
  const isRtl = rtl === '1'
  const scroll = layout === 'scroll'
  const box = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)

  // the pages shown together: a spread in double, else the one page
  const start = layout === 'double' ? spreadOf(page) : page
  const shown = layout === 'double' && start > 0 && start + 1 < count ? [start, start + 1] : [start]
  const last = shown[shown.length - 1]
  // where the page or spread before and after this one starts (a spread's
  // first page; the cover stands alone)
  const after = layout === 'double' ? (start === 0 ? 1 : start + 2) : start + 1
  const before = layout === 'double' ? (start === 0 ? -1 : start <= 1 ? 0 : start - 2) : start - 1

  // the strip mounts pages as they come near and keeps them, so nothing
  // above the reader shrinks under it
  const [near, setNear] = useState<[number, number]>([page - 1, page + 2])
  const widen = (i: number) => setNear(([lo, hi]) => [Math.min(lo, i - 1), Math.max(hi, i + 2)])
  const strip = useRef<HTMLDivElement>(null)
  const toPage = (i: number) => {
    setEnded(false)
    setPage(i)
    if (scroll) {
      widen(i)
      requestAnimationFrame(() => strip.current?.querySelector(`[data-page="${i}"]`)?.scrollIntoView())
    } else box.current?.querySelector('[data-at="0"][data-fit="width"]')?.scrollTo({ top: 0 })
  }
  const go = (d: number) => {
    if (ended) {
      if (d < 0) setEnded(false)
      return
    }
    const n = layout === 'double' ? (d > 0 ? (start === 0 ? 1 : start + 2) : start <= 1 ? 0 : start - 2) : page + d
    if (n >= 0 && n < count) toPage(n)
    else if (n >= count && d > 0) {
      if (scroll) strip.current?.scrollTo({ top: strip.current.scrollHeight })
      else setEnded(true)
    }
  }
  const next = () => go(1)
  const prev = () => go(-1)
  // the physical directions: on a right-to-left book "left" is forward
  const left = isRtl ? next : prev
  const right = isRtl ? prev : next
  const canNext = !ended && count > 0
  const canPrev = ended || page > 0

  useEffect(() => {
    for (let i = last + 1; i <= last + 2 && i < count; i++) preload?.(i)
  }, [last, count, preload])
  useEffect(() => {
    if (!done || count === 0 || last < count - 1) return
    try {
      localStorage.setItem(done, '1')
    } catch {
      // not remembered
    }
  }, [done, last, count])

  // the page takes focus on opening, so the arrow keys turn pages without a
  // click into it first
  useEffect(() => box.current?.focus({ preventScroll: true }), [])
  // a strip has no tap zones to bring the bars back, so they stay
  const setAutohide = useEffectEvent((on: boolean) => frame.setAutohide(on))
  useEffect(() => setAutohide(!scroll), [scroll])

  // the strip: the page across the middle of the reader is the page read
  const onCentre = useEffectEvent((i: number) => {
    if (i === page) return
    setPage(i)
    widen(i)
  })
  const toRead = useEffectEvent(() => strip.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView())
  useEffect(() => {
    const root = strip.current
    if (!scroll || !root) return
    toRead()
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) if (e.isIntersecting) onCentre(Number((e.target as HTMLElement).dataset.page))
      },
      { root, rootMargin: '-50% 0px -50% 0px' },
    )
    for (const el of root.querySelectorAll('[data-page]')) io.observe(el)
    return () => io.disconnect()
  }, [scroll, count])

  // a pinched-in page pans instead of turning
  const [zoomed, setZoomed] = useState(false)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const on = () => setZoomed(vv.scale > 1.01)
    vv.addEventListener('resize', on)
    return () => vv.removeEventListener('resize', on)
  }, [])

  // the drag: the page follows the finger sideways and turns, or springs
  // back, when it is let go
  const drag = useRef<{ x: number; y: number; at: number; id: number; axis?: 'x' | 'y'; dx: number } | null>(null)
  const dragged = useRef(false)
  const place = (dx: number, moving: boolean) => {
    const el = track.current
    if (!el) return
    el.toggleAttribute('data-moving', moving)
    el.style.transform = dx ? `translateX(${dx}px)` : ''
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragged.current = false
    if (e.pointerType === 'mouse' || scroll || ended || zoomed) return
    drag.current = { x: e.clientX, y: e.clientY, at: e.timeStamp, id: e.pointerId, dx: 0 }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return
      d.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (d.axis === 'x') e.currentTarget.setPointerCapture?.(e.pointerId)
    }
    if (d.axis !== 'x') return
    dragged.current = true
    // at the first page there is nothing behind: the page gives way only a little
    const blocked = (dx > 0 && !(isRtl ? canNext : canPrev)) || (dx < 0 && !(isRtl ? canPrev : canNext))
    d.dx = blocked ? dx / 4 : dx
    place(d.dx, false)
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (!d || e.pointerId !== d.id || d.axis !== 'x') return
    const w = box.current?.clientWidth ?? 0
    const out = dragOutcome(d.dx, e.timeStamp - d.at, w)
    const can = out === 'right' ? (isRtl ? canPrev : canNext) : out === 'left' ? (isRtl ? canNext : canPrev) : false
    const still =
      matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off'
    if (!out || !can) return place(0, !still)
    if (still) {
      place(0, false)
      return out === 'right' ? right() : left()
    }
    place(out === 'right' ? -w : w, true)
    setTimeout(() => {
      if (out === 'right') right()
      else left()
      place(0, false)
    }, 300)
  }

  const onKey = (e: KeyboardEvent) => {
    // Alt+arrow is the browser's back/forward, Ctrl/Cmd+key its own shortcuts
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const k = e.key
    // the strip scrolls by the keys the browser gives it
    if (scroll && k !== 'Home' && k !== 'End') return
    if (k === 'ArrowLeft') left()
    else if (k === 'ArrowRight') right()
    else if (k === ' ') (e.shiftKey ? prev : next)()
    else if (k === 'PageDown') next()
    else if (k === 'PageUp') prev()
    else if (k === 'Home') toPage(0)
    else if (k === 'End') toPage(count - 1)
    else return
    e.preventDefault()
  }
  // the outer 30 % turn, the middle shows or hides the bars
  const onTap = (e: MouseEvent<HTMLDivElement>) => {
    if (dragged.current) {
      dragged.current = false
      return
    }
    if (ended) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    if (scroll || (x >= 0.3 && x <= 0.7)) frame.toggle()
    else if (x < 0.3) left()
    else right()
  }

  const nextVol = end?.next ? volumeOf(end.next.name) : null
  const endView = (
    <div className="ws-rd-end">
      {end?.cover && <img src={end.cover} alt="" />}
      <h3>
        {done
          ? end?.volume != null
            ? t('reader.volumeRead', { n: end.volume })
            : t('reader.bookRead')
          : t('reader.endReached')}
      </h3>
      {done && (
        <p>
          {end?.next
            ? nextVol != null
              ? t('reader.nextOnDisk', { n: nextVol })
              : t('reader.nextOnDiskPlain')
            : t('reader.newest')}
        </p>
      )}
      <div className="ws-rd-end-acts">
        {end?.next && (
          <ReplaceLink to={end.next.href} className={buttonClass({ variant: 'primary' })}>
            {nextVol != null ? t('reader.readNext', { n: nextVol }) : t('viewer.nextVolume')}
          </ReplaceLink>
        )}
        <button type="button" className={buttonClass()} onClick={() => toPage(0)}>
          {t('viewer.fromStart')}
        </button>
        <button type="button" className={buttonClass()} onClick={frame.close}>
          {t('reader.overview')}
        </button>
      </div>
    </div>
  )

  const pageText = t('viewer.pageOf', {
    page: shown.length === 2 ? `${shown[0] + 1}–${shown[1] + 1}` : page + 1,
    count,
  })
  const count2 = shown.length === 2 ? `${shown[0] + 1}–${shown[1] + 1}` : String(page + 1)

  let body: ReactNode = null
  if (count > 0 && scroll)
    body = (
      <div ref={strip} className="ws-rd-scroll">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} data-page={i}>
            {i >= near[0] && i <= near[1] ? render(i, 'width') : <div className="aspect-[2/3] w-full" />}
          </div>
        ))}
        {/* past the strip counts as its last page, so the volume reads as done */}
        <div data-page={count - 1}>{endView}</div>
      </div>
    )
  else if (count > 0)
    body = (
      <div ref={track} className="ws-rd-track">
        {/* what is shown and, a screen to each side, what a drag brings in, so
            the next page or spread is already there while the finger pulls.
            Keyed by where it starts: on a turn the neighbour, pictures loaded,
            simply becomes the middle one */}
        {[isRtl ? after : before, start, isRtl ? before : after].map((s, at) => {
          if (s < 0 || s >= count) return null
          const pages = layout === 'double' && s > 0 && s + 1 < count ? [s, s + 1] : [s]
          const side = at !== 1 || undefined
          return pages.length === 2 ? (
            <div key={s} className="ws-rd-unit" data-at={at - 1} aria-hidden={side} inert={side}>
              {/* the spread meets in the middle: the first page hugs the gutter from its side */}
              <div className="ws-rd-spread" data-rtl={isRtl ? '' : undefined}>
                {pages.map((i) => (
                  <div key={i} className={(i === s) !== isRtl ? 'justify-end' : 'justify-start'}>
                    {render(i, 'height')}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div
              key={s}
              className="ws-rd-unit"
              data-at={at - 1}
              data-fit={layout === 'double' ? 'height' : fit}
              data-kind={kind}
              aria-hidden={side}
              inert={side}
            >
              {render(s, layout === 'double' ? 'height' : fit)}
            </div>
          )
        })}
      </div>
    )

  const tool = (
    on: boolean | undefined,
    onClick: () => void,
    icon: ReactNode,
    text: string,
    aria?: string,
    cls = '',
  ) => (
    <button
      type="button"
      className={`ws-rd-tool ${cls}`}
      aria-pressed={on}
      aria-label={aria}
      onClick={() => {
        onClick()
        frame.poke()
      }}
    >
      {icon}
      <span>{text}</span>
    </button>
  )
  const setLayoutTo = (l: PageLayout) => {
    setLayout(l)
    setEnded(false)
    setNear([page - 1, page + 2])
  }
  const dirText = isRtl ? t('reader.dirRtl') : t('reader.dirLtr')
  const fitText = fit === 'height' ? t('reader.fitHeight') : t('reader.fitWidth')

  return (
    <>
      <FrameSub>{end?.volume != null ? t('reader.volumeSub', { n: end.volume, page: pageText }) : pageText}</FrameSub>
      {/* the page: focusable so the keys work right away; the taps and drags
        are the pointer's shortcut for the slider and keys, not the only way */}
      <div
        ref={box}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region has to take focus to scroll by keyboard (and here to turn pages)
        tabIndex={0}
        role="region"
        aria-roledescription={t('viewer.reader')}
        aria-label={label}
        onKeyDown={onKey}
        onClick={onTap}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null
          place(0, true)
        }}
        className="ws-rd-stage"
      >
        {body}
        {ended && !scroll && endView}
      </div>
      {hint && !scroll && (
        <div className="ws-rd-hint" aria-hidden>
          <ChevronLeft />
          <span>{t('reader.hint')}</span>
          <ChevronRight />
        </div>
      )}
      <div className="ws-rd-bottom">
        <div className="ws-rd-sl">
          <input
            type="range"
            min={1}
            max={Math.max(count, 1)}
            value={page + 1}
            dir={isRtl ? 'rtl' : 'ltr'}
            onChange={(e) => toPage(Number(e.target.value) - 1)}
            aria-label={t('viewer.page')}
            aria-valuetext={pageText}
          />
          <span className="ws-rd-count" aria-hidden>
            {count2} / {count}
          </span>
        </div>
        <div className="ws-rd-tools" role="group" aria-label={t('viewer.layout')}>
          {tool(undefined, () => setOverview(true), <LayoutGrid aria-hidden />, t('reader.pages'))}
          {tool(
            undefined,
            () => setRtl(isRtl ? '0' : '1'),
            <ArrowLeftRight aria-hidden />,
            dirText,
            t('reader.dirIs', { dir: dirText }),
          )}
          {layout === 'single' &&
            tool(
              undefined,
              () => setFit(fit === 'height' ? 'width' : 'height'),
              fit === 'height' ? <MoveVertical aria-hidden /> : <MoveHorizontal aria-hidden />,
              fitText,
              t('reader.fitIs', { fit: fitText }),
            )}
          {tool(
            layout === 'double',
            () => setLayoutTo(layout === 'double' ? 'single' : 'double'),
            <BookOpen aria-hidden />,
            t('viewer.layout_double'),
            undefined,
            'ws-rd-desk',
          )}
          {tool(
            scroll,
            () => setLayoutTo(scroll ? 'single' : 'scroll'),
            <GalleryVertical aria-hidden />,
            t('reader.scroll'),
          )}
        </div>
      </div>
      {overview && (
        <ReaderSheet title={t('reader.pages')} wide onClose={() => setOverview(false)}>
          <Overview
            count={count}
            at={page}
            thumb={thumb}
            rtl={isRtl}
            onPick={(i) => {
              setOverview(false)
              toPage(layout === 'double' ? spreadOf(i) : i)
            }}
          />
        </ReaderSheet>
      )}
    </>
  )
}

/** A link that takes the reader's place in the history (the next volume after this one). */
function ReplaceLink({ to, className, children }: { to: string; className: string; children: ReactNode }) {
  const nav = useNavigate()
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        nav(to, { replace: true })
      }}
    >
      {children}
    </a>
  )
}

/** Every page of the book at a glance, to jump to one. */
function Overview({
  count,
  at,
  thumb,
  rtl,
  onPick,
}: {
  count: number
  at: number
  thumb?: (i: number) => string
  rtl: boolean
  onPick: (i: number) => void
}) {
  const { t } = useTranslation()
  // the overview opens on the page being read
  const cur = useRef<HTMLButtonElement>(null)
  useEffect(() => cur.current?.scrollIntoView?.({ block: 'center' }), [])
  return (
    <ol
      dir={rtl ? 'rtl' : 'ltr'}
      className="ws-rd-thgrid"
      style={thumb ? undefined : { gridTemplateColumns: 'repeat(auto-fill, minmax(3rem, 1fr))' }}
    >
      {Array.from({ length: count }, (_, i) => (
        <li key={i}>
          <button
            ref={i === at ? cur : undefined}
            type="button"
            aria-current={i === at ? 'page' : undefined}
            aria-label={t('viewer.pageOf', { page: i + 1, count })}
            onClick={() => onPick(i)}
          >
            {thumb && <img src={thumb(i)} alt="" loading="lazy" decoding="async" />}
            <span aria-hidden>{i + 1}</span>
          </button>
        </li>
      ))}
    </ol>
  )
}

/** A page picture, fitted to the height or the width of the reader. */
export function PageImage({
  src,
  fit,
  alt,
  onLoad,
  onError,
}: {
  src: string
  fit: 'width' | 'height'
  alt: string
  onLoad?: () => void
  onError?: () => void
}) {
  return (
    <img
      src={src}
      alt={alt}
      onLoad={onLoad}
      onError={onError}
      decoding="async"
      draggable={false}
      className={fit === 'height' ? 'max-h-full max-w-full object-contain' : 'h-auto w-full'}
    />
  )
}

const warm = (src: string) => {
  const i = new Image()
  i.decoding = 'async'
  i.src = src
}

// ---- unpacked books ----

/** The book after this one in its folder. */
export interface NextBook {
  href: string
  name: string
}

/** The book after this one in its folder, for the end of a volume. */
export function useNextBook(server: number, path: string): NextBook | undefined {
  const folder = useQuery(folderOf(server, path))
  const books = (folder.data ?? []).filter((e) => !e.isDir && isBook(e.name)).sort(byName)
  const i = books.findIndex((e) => e.path === path)
  return i >= 0 && i + 1 < books.length
    ? { href: viewHref(server, books[i + 1].path), name: books[i + 1].name }
    : undefined
}

/** The end of a volume: its number, the next one in the folder, and the title's cover from the catalog match. */
export function useBookEnd(server: number, path: string): PagedEnd {
  const qc = useQueryClient()
  const next = useNextBook(server, path)
  const title = useQuery({
    queryKey: ['reader-title', server, path],
    queryFn: () => catalogTitle(qc, server, path),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const media = title.data?.media
  return {
    volume: volumeOf(path.split('/').pop() ?? ''),
    next,
    cover: media?.coverImage?.extraLarge || media?.coverImage?.large || undefined,
  }
}

/**
 * The read-open token lives as long as the server keeps the unpacked book
 * (a handful of books, gone on restart), the cached answer for 30 minutes.
 * A page or chapter that fails to load asks for the token again, once until
 * something loads. The new answer carries the new base, so the reader goes on
 * where it was.
 */
function useReviveBook(server: number, path: string) {
  const qc = useQueryClient()
  const asked = useRef(false)
  return {
    revive: () => {
      if (asked.current) return
      asked.current = true
      void qc.invalidateQueries({ queryKey: ['read-open', server, path] })
    },
    alive: () => {
      asked.current = false
    },
  }
}

function BookView({ server, path }: { server: number; path: string }) {
  const { t } = useTranslation()
  const end = useBookEnd(server, path)
  const { revive, alive } = useReviveBook(server, path)
  const book = useQuery({
    queryKey: ['read-open', server, path],
    queryFn: () => api.get<ReaderBook>(`/api/read/open?server=${server}&path=${encodeURIComponent(path)}`),
    staleTime: 30 * 60_000,
    retry: false,
  })
  if (book.isPending) return <ReaderState loading label={t('viewer.unpacking')} />
  if (book.error) return <ReaderState error={book.error} />
  const b = book.data
  if (b.kind === 'epub') return <EpubView base={b.base} server={server} path={path} onDead={revive} />
  if (b.kind === 'sheet') return <SheetView base={b.base} path={path} />
  const pages = b.pages ?? []
  return (
    <Paged
      count={pages.length}
      page={`viewer.page:${server}:${path}`}
      done={doneKey(server, path)}
      direction="manga"
      label={path.split('/').pop() ?? ''}
      end={end}
      preload={(i) => warm(bookUrl(b.base, pages[i]))}
      thumb={(i) => bookUrl(b.base, pages[i])}
      render={(i, fit) => (
        <PageImage
          src={bookUrl(b.base, pages[i])}
          fit={fit}
          alt={t('viewer.pageOf', { page: i + 1, count: pages.length })}
          onLoad={alive}
          onError={revive}
        />
      )}
    />
  )
}

async function fetchText(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

interface EpubData {
  title: string
  chapters: EpubChapter[]
}

async function loadEpub(base: string): Promise<EpubData> {
  const opfPath = epubRootfile(await fetchText(bookUrl(base, 'META-INF/container.xml')))
  const book = epubSpine(await fetchText(bookUrl(base, opfPath)), opfPath)
  const tocPath = book.nav || book.ncx
  if (tocPath) {
    try {
      const labels = epubToc(await fetchText(bookUrl(base, tocPath)), tocPath)
      for (const c of book.chapters) c.label = labels.get(c.href) ?? ''
    } catch {
      // numbered chapters are still a book
    }
  }
  return { title: book.title, chapters: book.chapters }
}

/**
 * An EPUB, one chapter at a time, each in a sandboxed frame: the book's
 * markup is someone else's, so it gets no script and no origin. The type and
 * the background go in as a stylesheet the server writes into the chapter
 * (the frame cannot be reached from here); the frame scrolls the chapter
 * itself, the bar turns chapters. A position inside a chapter cannot be read
 * from a frame without scripts, so progress counts in chapters.
 */
function EpubView({
  base,
  server,
  path,
  onDead,
}: {
  base: string
  server: number
  path: string
  onDead: () => void
}) {
  const { t } = useTranslation()
  const frame = useFrame()
  const data = useQuery({ queryKey: ['epub', base], queryFn: () => loadEpub(base), staleTime: Infinity })
  const [at, setAt] = useStored<number>(`viewer.chapter:${server}:${path}`, 0)
  const [size, setSize] = useStored<number>('viewer.bkSize', 19)
  const [lead, setLead] = useStored<number>('viewer.bkLead', 1.6)
  const [font, setFont] = useStored<string>('viewer.bkFont', 'serif')
  const [toc, setToc] = useState(false)
  const [typo, setTypo] = useState(false)
  // taps land in the chapter's frame, out of reach: the bars stay
  const setAutohide = useEffectEvent((on: boolean) => frame.setAutohide(on))
  useEffect(() => setAutohide(false), [])
  // the last chapter reached: the book is read
  const chapters = data.data?.chapters.length ?? 0
  useEffect(() => {
    if (!chapters || at < chapters - 1) return
    try {
      localStorage.setItem(doneKey(server, path), '1')
    } catch {
      // not remembered
    }
  }, [chapters, at, server, path])
  // a frame shows no status of its own: ask the server whether the chapter is
  // still there, a 404/410 means the book was unpacked away
  const dead = useEffectEvent(onDead)
  const failed = !!data.error
  useEffect(() => {
    if (failed) dead()
  }, [failed])
  const href = data.data?.chapters[Math.min(Math.max(at, 0), Math.max(chapters - 1, 0))]?.href
  useEffect(() => {
    if (href === undefined) return
    const ctl = new AbortController()
    fetch(bookUrl(base, href), { method: 'HEAD', signal: ctl.signal })
      .then((res) => {
        if (res.status === 404 || res.status === 410) dead()
      })
      .catch(() => {})
    return () => ctl.abort()
  }, [base, href])
  if (data.isPending) return <ReaderState loading />
  if (data.error) return <ReaderState error={data.error} />
  const ch = data.data.chapters
  if (!ch.length) return <ReaderState error={new Error(t('viewer.noChapters'))} />
  const i = Math.min(Math.max(at, 0), ch.length - 1)
  const labelOf = (c: EpubChapter, n: number) => c.label || t('viewer.chapterN', { n: n + 1 })
  const look: BookLook = {
    size: Math.round(clampTo(size, 15, 26, 19)),
    lead: clampTo(lead, 1.3, 1.9, 1.6),
    theme: frame.theme,
    font: font === 'sans' ? 'sans' : 'serif',
  }
  const sub = t('reader.chapterSub', { n: i + 1, count: ch.length })
  return (
    <>
      <FrameSub>{sub}</FrameSub>
      <FrameTools>
        <button
          type="button"
          className="ws-rd-ic"
          aria-label={t('viewer.contents')}
          title={t('viewer.contents')}
          onClick={() => setToc(true)}
        >
          <List aria-hidden />
        </button>
        <button
          type="button"
          className="ws-rd-ic"
          aria-label={t('reader.typo')}
          title={t('reader.typo')}
          onClick={() => setTypo(true)}
        >
          <span className="ws-rd-aa" aria-hidden>
            Aa
          </span>
        </button>
      </FrameTools>
      <div className="ws-rd-book">
        <iframe
          key={ch[i].href}
          title={labelOf(ch[i], i)}
          src={lookedUrl(bookUrl(base, ch[i].href), look)}
          sandbox=""
          referrerPolicy="no-referrer"
        />
      </div>
      <div className="ws-rd-bottom">
        <div className="ws-rd-sl">
          <button
            type="button"
            className="ws-rd-ic"
            aria-label={t('viewer.prevChapter')}
            onClick={() => setAt(i - 1)}
            disabled={i === 0}
          >
            <SkipBack aria-hidden />
          </button>
          <input
            type="range"
            min={1}
            max={ch.length}
            value={i + 1}
            onChange={(e) => setAt(Number(e.target.value) - 1)}
            aria-label={t('reader.chapter')}
            aria-valuetext={`${labelOf(ch[i], i)}, ${sub}`}
          />
          <span className="ws-rd-count" aria-hidden>
            {i + 1} / {ch.length}
          </span>
          <button
            type="button"
            className="ws-rd-ic"
            aria-label={t('viewer.nextChapter')}
            onClick={() => setAt(i + 1)}
            disabled={i >= ch.length - 1}
          >
            <SkipForward aria-hidden />
          </button>
        </div>
      </div>
      {toc && (
        <ReaderSheet title={t('viewer.contents')} onClose={() => setToc(false)}>
          <ol className="ws-rd-toc">
            {ch.map((c, n) => (
              <li key={c.href}>
                <button
                  type="button"
                  aria-current={n === i ? 'page' : undefined}
                  onClick={() => {
                    setAt(n)
                    setToc(false)
                  }}
                >
                  <span>{labelOf(c, n)}</span>
                  {n < i && <span>{t('reader.read')}</span>}
                </button>
              </li>
            ))}
          </ol>
        </ReaderSheet>
      )}
      {typo && (
        <ReaderSheet title={t('reader.typo')} onClose={() => setTypo(false)}>
          <TypoSettings look={look} onSize={setSize} onLead={setLead} onTheme={frame.setTheme} onFont={setFont} />
        </ReaderSheet>
      )}
    </>
  )
}

/** Type and colours of an EPUB: size, line height, background and typeface. */
function TypoSettings({
  look,
  onSize,
  onLead,
  onTheme,
  onFont,
}: {
  look: BookLook
  onSize: (n: number) => void
  onLead: (n: number) => void
  onTheme: (t: ReaderTheme) => void
  onFont: (f: string) => void
}) {
  const { t, i18n } = useTranslation()
  const num = new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return (
    <>
      <label className="grid gap-1">
        <span className="ws-rd-lbl">{t('reader.size')}</span>
        <span className="ws-rd-range">
          <span className="sm" aria-hidden>
            A
          </span>
          <input
            type="range"
            min={15}
            max={26}
            value={look.size}
            onChange={(e) => onSize(Number(e.target.value))}
            aria-valuetext={`${look.size} px`}
          />
          <span className="lg" aria-hidden>
            A
          </span>
        </span>
      </label>
      <label className="grid gap-1">
        <span className="ws-rd-lbl">{t('reader.lead')}</span>
        <input
          type="range"
          min={13}
          max={19}
          value={Math.round(look.lead * 10)}
          onChange={(e) => onLead(Number(e.target.value) / 10)}
          aria-valuetext={num.format(look.lead)}
        />
      </label>
      <div className="grid gap-1" role="group" aria-labelledby="ws-rd-bg">
        <span id="ws-rd-bg" className="ws-rd-lbl">
          {t('reader.background')}
        </span>
        <div className="ws-rd-themes">
          {READER_THEMES.map((th) => (
            <button key={th} type="button" data-th={th} aria-pressed={look.theme === th} onClick={() => onTheme(th)}>
              {t(`reader.theme_${th}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-1">
        <span className="ws-rd-lbl" aria-hidden>
          {t('reader.font')}
        </span>
        <Segmented
          aria-label={t('reader.font')}
          value={look.font}
          onChange={onFont}
          options={[
            { value: 'serif', label: t('reader.serif') },
            { value: 'sans', label: t('reader.sans') },
          ]}
        />
      </div>
    </>
  )
}

async function loadSheets(base: string, path: string): Promise<Sheet[]> {
  if (/\.ods$/i.test(path)) return odsSheets(await fetchText(bookUrl(base, 'content.xml')))
  const parts = xlsxSheetParts(
    await fetchText(bookUrl(base, 'xl/workbook.xml')),
    await fetchText(bookUrl(base, 'xl/_rels/workbook.xml.rels')),
  )
  const strings = await fetchText(bookUrl(base, 'xl/sharedStrings.xml')).then(xlsxStrings, () => [])
  return Promise.all(
    parts.map(async (p) => ({ name: p.name, rows: xlsxRows(await fetchText(bookUrl(base, p.path)), strings) })),
  )
}

/** A view that has no tap zones: the bars stay. */
function useBarsStay() {
  const frame = useFrame()
  const set = useEffectEvent(() => frame.setAutohide(false))
  useEffect(() => set(), [])
}

/** A spreadsheet's values, one sheet at a time. Formulas show their last result. */
function SheetView({ base, path }: { base: string; path: string }) {
  const { t } = useTranslation()
  useBarsStay()
  const data = useQuery({ queryKey: ['sheets', base], queryFn: () => loadSheets(base, path), staleTime: Infinity })
  const [at, setAt] = useState(0)
  if (data.isPending) return <ReaderState loading />
  if (data.error) return <ReaderState error={data.error} />
  const sheets = data.data
  const sheet = sheets[Math.min(at, sheets.length - 1)]
  if (!sheet) return <ReaderState error={new Error(t('viewer.emptySheet'))} />
  const width = Math.max(0, ...sheet.rows.map((r) => r.length))
  const nameOf = (s: Sheet, n: number) => s.name || t('viewer.sheetN', { n: n + 1 })
  return (
    <div className="ws-rd-sheet">
      <FrameSub>{nameOf(sheet, at)}</FrameSub>
      {sheets.length > 1 && (
        <div className="ws-rd-tools" role="group" aria-label={t('viewer.sheets')}>
          {sheets.map((s, n) => (
            <button
              key={s.name + n}
              type="button"
              className="ws-rd-tool"
              aria-pressed={n === at}
              onClick={() => setAt(n)}
            >
              {nameOf(s, n)}
            </button>
          ))}
        </div>
      )}
      <div
        className="ws-rd-sheet-box"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region has to take focus to scroll by keyboard
        tabIndex={0}
        role="region"
        aria-label={nameOf(sheet, at)}
      >
        <table className="t-sheet ws-rd-table text-sm">
          <tbody>
            {sheet.rows.map((r, y) => (
              <tr key={y}>
                <th scope="row">{y + 1}</th>
                {Array.from({ length: width }, (_, x) => (
                  <td key={x}>{r[x] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---- files streamed as they are ----

const folderOf = (server: number, path: string) => ({
  queryKey: ['view-folder', server, parentOf(path)],
  queryFn: () => listFolder(server, parentOf(path)),
  staleTime: 60_000,
})

/** A picture, with the other pictures of its folder a swipe away. */
function ImageView({ server, path }: { server: number; path: string }) {
  const folder = useQuery(folderOf(server, path))
  if (folder.isPending) return <ReaderState loading />
  const images = (folder.data ?? [])
    .filter((e) => !e.isDir && viewKind(e.name) === 'image')
    .sort(byName)
    .map((e) => e.path)
  const list = images.includes(path) ? images : [path]
  return (
    <Paged
      count={list.length}
      page=""
      initial={list.indexOf(path)}
      direction="western"
      label={path.split('/').pop() ?? ''}
      preload={(i) => warm(streamUrl(server, list[i]))}
      thumb={(i) => streamUrl(server, list[i])}
      render={(i, fit) => <PageImage src={streamUrl(server, list[i])} fit={fit} alt={list[i].split('/').pop() ?? ''} />}
    />
  )
}

// text is read up to this much; a log of hundreds of megabytes is not for reading here
const TEXT_LIMIT = 4 << 20

function TextView({ server, path }: { server: number; path: string }) {
  const { t } = useTranslation()
  useBarsStay()
  const name = path.split('/').pop() ?? ''
  const text = useQuery({
    queryKey: ['view-text', server, path],
    queryFn: async () => {
      const res = await fetch(streamUrl(server, path), { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const total = res.status === 206 && /\/(\d+)$/.exec(res.headers.get('Content-Range') ?? '')
      const cut = !!total && Number(total[1]) > TEXT_LIMIT
      return { text: decodeText(new Uint8Array(await res.arrayBuffer()), name, cut), cut }
    },
  })
  if (text.isPending) return <ReaderState loading />
  if (text.error) return <ReaderState error={text.error} />
  const ext = (name.split('.').pop() ?? '').toUpperCase()
  return (
    <div
      className="ws-rd-text"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region has to take focus to scroll by keyboard
      tabIndex={0}
      role="region"
      aria-label={name}
    >
      <FrameSub>{t('reader.textSub', { ext })}</FrameSub>
      {text.data.cut && <p className="ws-rd-note">{t('viewer.cut')}</p>}
      {/\.md$/i.test(name) ? (
        <div className="ws-rd-prose">
          <Markdown text={text.data.text} />
        </div>
      ) : (
        <pre className={/\.(nfo|diz)$/i.test(name) ? 't-nfo whitespace-pre' : 'whitespace-pre-wrap wrap-break-word'}>
          {text.data.text}
        </pre>
      )}
    </div>
  )
}

/**
 * A track and the rest of its folder as the queue: the next one starts when
 * one ends. The sound itself plays in the app's one audio element, so it goes
 * on when this page is left; the mini player keeps it in reach meanwhile.
 */
function AudioView({ server, path }: { server: number; path: string }) {
  const folder = useQuery(folderOf(server, path))
  const audio = useAudio()
  const entries = folder.data ?? []
  const tracks = entries.filter((e) => !e.isDir && viewKind(e.name) === 'audio').sort(byName)
  const coverEntry =
    entries.find((e) => !e.isDir && /^(cover|folder|front)\.(jpe?g|png|webp)$/i.test(e.name)) ??
    entries.find((e) => !e.isDir && viewKind(e.name) === 'image')
  const cover = coverEntry && streamUrl(server, coverEntry.path)
  const name = path.split('/').pop() ?? ''

  // opening a track plays it, with its folder as the queue; the track already
  // playing (back from the mini player) just carries on
  const begin = useEffectEvent(() => {
    const cur = audio.track
    if (cur?.path === path && audio.queue?.server === server) return
    const list = tracks.some((e) => e.path === path) ? tracks : [{ name, path, isDir: false, size: 0, modTime: '' }]
    audio.start({
      server,
      tracks: list,
      at: list.findIndex((e) => e.path === path),
      album: parentOf(path).split('/').pop() ?? '',
      cover,
    })
  })
  useEffect(() => {
    if (!folder.isPending) begin()
  }, [folder.isPending])

  return (
    <div className="ws-au-page">
      <AudioPanel heading />
    </div>
  )
}
