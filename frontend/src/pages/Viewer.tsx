import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import {
  AArrowDown,
  AArrowUp,
  ArrowLeftRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  GalleryVertical,
  LayoutGrid,
  Maximize,
  MoonStar,
  MoveHorizontal,
  MoveVertical,
  Pause,
  Play,
  RectangleVertical,
  Repeat,
  Repeat1,
  SkipBack,
  SkipForward,
  type LucideIcon,
} from 'lucide-react'
import {
  Button,
  buttonClass,
  Cover,
  Dialog,
  EmptyState,
  IconButton,
  Modal,
  Panel,
  Select,
  Tab,
  Tabs,
  Toolbar,
  useSwipe,
} from 'fluid-lycoris'
import { api, type Entry } from '../api'
import Loading from '../components/Loading'
import { clock, useAudio, type Repeat as RepeatMode } from '../components/AudioPlayer'
import { useStored } from '../hooks/useStored'
import Markdown from '../components/Markdown'
import FileIcon from '../components/FileIcon'
import {
  doneKey,
  filesLink,
  isBook,
  listFolder,
  streamUrl,
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
  return (
    <div className="page-fill flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <FileIcon isDir={false} name={name} />
        <h2 className="min-w-0 flex-1 truncate font-display text-base" title={path}>
          {name}
        </h2>
        <Link className={buttonClass({ size: 'sm', className: 'shrink-0' })} to={filesLink(server, parentOf(path))}>
          {t('viewer.inFolder')}
        </Link>
      </div>
      <Body kind={kind} server={server} path={path} />
    </div>
  )
}

function Body({ kind, server, path }: { kind: ViewKind; server: number; path: string }) {
  switch (kind) {
    case 'comic':
    case 'epub':
    case 'sheet':
      return <BookView server={server} path={path} />
    case 'pdf':
      return (
        <Suspense fallback={<Loading />}>
          <PdfView server={server} path={path} />
        </Suspense>
      )
    case 'audio':
      return <AudioView server={server} path={path} />
    case 'image':
      return <ImageView server={server} path={path} />
    case 'text':
      return <TextView server={server} path={path} />
  }
}

function Failed({ error }: { error: unknown }) {
  const { t } = useTranslation()
  return (
    <p className="rounded-md border border-err/40 px-3 py-2 text-sm text-err" role="alert">
      {t('viewer.loadError')} {error instanceof Error ? error.message : ''}
    </p>
  )
}

// ---- paged reading: comics, PDFs, a folder of pictures ----

export type PageLayout = 'single' | 'double' | 'scroll'

// a spread opens on an odd page: the cover stands alone, then 1+2, 3+4 …
export const spreadOf = (p: number) => (p === 0 ? 0 : p - ((p - 1) % 2))

/**
 * One page at a time, two side by side, or the whole book as one long strip
 * the way a webtoon reads. Pages turn by swipe, tap on the outer thirds, the
 * arrow keys or the slider; right to left reverses all of it, the way a
 * manga reads. The page shown is remembered per file; past the last one the
 * end of the volume offers the next.
 */
export function Paged({
  count,
  page: pageKey,
  initial = 0,
  direction,
  render,
  preload,
  thumb,
  label,
  done,
  nextHref,
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
  render: (i: number, fit: 'width' | 'height') => ReactNode
  preload?: (i: number) => void
  /** a small picture of a page for the overview; without it the overview lists numbers */
  thumb?: (i: number) => string
  label: string
  /** storage key set once the last page was shown: the volume is read */
  done?: string
  /** the next volume of the folder, offered once this one is through */
  nextHref?: string
}) {
  const { t } = useTranslation()
  const [stored, setStored] = useStored<number>(pageKey || 'viewer.none', initial)
  const [local, setLocal] = useState(initial)
  const page = Math.min(Math.max(pageKey ? stored : local, 0), Math.max(count - 1, 0))
  const setPage = (i: number) => (pageKey ? setStored(i) : setLocal(i))
  const [rtl, setRtl] = useStored<string>(`viewer.rtl.${direction}`, direction === 'manga' ? '1' : '0')
  const [fit, setFit] = useStored<'width' | 'height'>('viewer.fit', 'height')
  // kept per direction like the reading way: a manga in spreads leaves the PDFs alone
  const [layout, setLayout] = useStored<PageLayout>(`viewer.layout.${direction}`, 'single')
  const [overview, setOverview] = useState(false)
  // past the last page: the end of the volume stands in for a page
  const [ended, setEnded] = useState(false)
  const isRtl = rtl === '1'
  const scroll = layout === 'scroll'
  const box = useRef<HTMLDivElement>(null)

  // the pages shown together: a spread in double, else the one page
  const start = layout === 'double' ? spreadOf(page) : page
  const shown = layout === 'double' && start > 0 && start + 1 < count ? [start, start + 1] : [start]
  const last = shown[shown.length - 1]

  // the strip mounts pages as they come near and keeps them, so nothing
  // above the reader shrinks under it
  const [near, setNear] = useState<[number, number]>([page - 1, page + 2])
  const widen = (i: number) => setNear(([lo, hi]) => [Math.min(lo, i - 1), Math.max(hi, i + 2)])
  const toPage = (i: number) => {
    setEnded(false)
    setPage(i)
    if (scroll) {
      widen(i)
      requestAnimationFrame(() => box.current?.querySelector(`[data-page="${i}"]`)?.scrollIntoView())
    } else box.current?.scrollTo({ top: 0 })
  }
  const go = (d: number) => {
    if (ended) {
      if (d < 0) setEnded(false)
      return
    }
    const n = layout === 'double' ? (d > 0 ? (start === 0 ? 1 : start + 2) : start <= 1 ? 0 : start - 2) : page + d
    if (n >= 0 && n < count) toPage(n)
    else if (n >= count && d > 0) {
      if (scroll) box.current?.scrollTo({ top: box.current.scrollHeight })
      else setEnded(true)
    }
  }
  const next = () => go(1)
  const prev = () => go(-1)
  // the physical directions: on a right-to-left book "left" is forward
  const left = isRtl ? next : prev
  const right = isRtl ? prev : next

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

  // the strip: the page across the middle of the reader is the page read
  const onCentre = useEffectEvent((i: number) => {
    if (i === page) return
    setPage(i)
    widen(i)
  })
  const toRead = useEffectEvent(() => box.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView())
  useEffect(() => {
    const root = box.current
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
  // the hook's onNext is a swipe to the left, which is "left" here too
  const swipe = useSwipe({ onNext: right, onPrev: left, disabled: zoomed || scroll, mouse: false })

  const onKey = (e: KeyboardEvent) => {
    const k = e.key
    // the strip scrolls by the keys the browser gives it
    if (scroll && k !== 'Home' && k !== 'End') return
    if (k === 'ArrowLeft') left()
    else if (k === 'ArrowRight') right()
    else if (k === 'PageDown' || k === ' ') next()
    else if (k === 'PageUp') prev()
    else if (k === 'Home') toPage(0)
    else if (k === 'End') toPage(count - 1)
    else return
    e.preventDefault()
  }
  const onTap = (e: MouseEvent<HTMLDivElement>) => {
    if (scroll || ended) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    if (x < 1 / 3) left()
    else if (x > 2 / 3) right()
  }
  const fullscreen = () => {
    const el = box.current?.parentElement
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else el?.requestFullscreen?.().catch(() => {})
  }

  const end = (
    <div className="grid max-w-sm justify-items-center gap-3 p-6 text-center text-white">
      <p className="font-display text-lg font-semibold text-balance">{t('viewer.endTitle')}</p>
      <p className="text-sm text-pretty text-white/70">{nextHref ? t('viewer.endNext') : t('viewer.endLast')}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {nextHref && (
          <Link to={nextHref} replace className={buttonClass({ variant: 'primary' })}>
            {t('viewer.nextVolume')}
          </Link>
        )}
        <button type="button" className={buttonClass()} onClick={() => toPage(0)}>
          {t('viewer.fromStart')}
        </button>
      </div>
    </div>
  )

  let body: ReactNode = null
  if (count > 0 && scroll)
    body = (
      <div className="mx-auto flex w-full max-w-3xl flex-col">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} data-page={i} className="w-full">
            {i >= near[0] && i <= near[1] ? render(i, 'width') : <div className="aspect-[2/3] w-full" />}
          </div>
        ))}
        {/* past the strip counts as its last page, so the volume reads as done */}
        <div data-page={count - 1} className="grid min-h-[60dvh] place-items-center">
          {end}
        </div>
      </div>
    )
  else if (count > 0 && ended) body = end
  else if (count > 0 && shown.length === 2)
    // the spread meets in the middle: the first page hugs the gutter from its side
    body = (
      <div className={`absolute inset-0 flex ${isRtl ? 'flex-row-reverse' : ''}`}>
        {shown.map((i) => (
          <div
            key={i}
            className={`flex h-full w-1/2 items-center ${(i === shown[0]) !== isRtl ? 'justify-end' : 'justify-start'}`}
          >
            {render(i, 'height')}
          </div>
        ))}
      </div>
    )
  else if (count > 0) body = render(start, layout === 'double' ? 'height' : fit)

  const centred = !scroll && (ended || layout === 'double' || fit === 'height')
  const pageText = t('viewer.pageOf', {
    page: shown.length === 2 ? `${shown[0] + 1}–${shown[1] + 1}` : page + 1,
    count,
  })
  const layouts: [PageLayout, LucideIcon][] = [
    ['single', RectangleVertical],
    ['double', BookOpen],
    ['scroll', GalleryVertical],
  ]

  return (
    <Panel className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* the page: focusable so the keys work right away; the taps and swipes
        are the pointer's shortcut for the buttons below, not the only way */}
      <div
        ref={box}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region has to take focus to scroll by keyboard (and here to turn pages)
        tabIndex={0}
        role="region"
        aria-roledescription={t('viewer.reader')}
        aria-label={label}
        onKeyDown={onKey}
        onClick={onTap}
        {...swipe}
        className={`t-reader-page relative min-h-0 flex-1 overflow-auto bg-black ${centred ? 'grid place-items-center' : ''}`}
        style={{ touchAction: 'pan-y pinch-zoom' }}
      >
        {body}
      </div>
      <Toolbar className="border-t border-border-subtle p-2">
        <IconButton aria-label={t('viewer.pageLeft')} onClick={left} disabled={isRtl ? ended : page <= 0 && !ended}>
          <ChevronLeft aria-hidden />
        </IconButton>
        <input
          type="range"
          min={1}
          max={Math.max(count, 1)}
          value={page + 1}
          dir={isRtl ? 'rtl' : 'ltr'}
          onChange={(e) => toPage(Number(e.target.value) - 1)}
          aria-label={t('viewer.page')}
          aria-valuetext={pageText}
          className="t-reader-slider min-w-24 flex-1"
        />
        <IconButton aria-label={t('viewer.pageRight')} onClick={right} disabled={isRtl ? page <= 0 && !ended : ended}>
          <ChevronRight aria-hidden />
        </IconButton>
        <span className="min-w-16 text-center font-mono text-xs tabular-nums text-t-muted" aria-live="polite">
          {pageText}
        </span>
        {/* the reading options keep to the right edge: on a phone they wrap into a
          second row under the page controls instead of trailing them */}
        <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <span role="group" aria-label={t('viewer.layout')} className="flex items-center gap-1">
            {layouts.map(([l, Icon]) => (
              <IconButton
                key={l}
                aria-label={t(`viewer.layout_${l}`)}
                title={t(`viewer.layout_${l}`)}
                aria-pressed={layout === l}
                onClick={() => {
                  setLayout(l)
                  setEnded(false)
                  setNear([page - 1, page + 2])
                }}
              >
                <Icon aria-hidden />
              </IconButton>
            ))}
          </span>
          <IconButton aria-label={t('viewer.overview')} title={t('viewer.overview')} onClick={() => setOverview(true)}>
            <LayoutGrid aria-hidden />
          </IconButton>
          <IconButton
            aria-label={t('viewer.rtl')}
            aria-pressed={isRtl}
            onClick={() => setRtl(isRtl ? '0' : '1')}
            title={t('viewer.rtl')}
          >
            <ArrowLeftRight aria-hidden />
          </IconButton>
          {layout === 'single' && (
            <IconButton
              aria-label={fit === 'height' ? t('viewer.fitWidth') : t('viewer.fitHeight')}
              title={fit === 'height' ? t('viewer.fitWidth') : t('viewer.fitHeight')}
              onClick={() => setFit(fit === 'height' ? 'width' : 'height')}
            >
              {fit === 'height' ? <MoveHorizontal aria-hidden /> : <MoveVertical aria-hidden />}
            </IconButton>
          )}
          {document.fullscreenEnabled && (
            <IconButton aria-label={t('viewer.fullscreen')} title={t('viewer.fullscreen')} onClick={fullscreen}>
              <Maximize aria-hidden />
            </IconButton>
          )}
        </span>
      </Toolbar>
      {overview && (
        <Overview
          count={count}
          at={page}
          thumb={thumb}
          rtl={isRtl}
          onPick={(i) => {
            setOverview(false)
            toPage(layout === 'double' ? spreadOf(i) : i)
          }}
          onClose={() => setOverview(false)}
        />
      )}
    </Panel>
  )
}

/** Every page of the book at a glance, to jump to one. */
function Overview({
  count,
  at,
  thumb,
  rtl,
  onPick,
  onClose,
}: {
  count: number
  at: number
  thumb?: (i: number) => string
  rtl: boolean
  onPick: (i: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  // the overview opens on the page being read
  const cur = useRef<HTMLButtonElement>(null)
  useEffect(() => cur.current?.scrollIntoView({ block: 'center' }), [])
  return (
    <Dialog width="max-w-3xl" aria-label={t('viewer.overview')} onClose={onClose}>
      <Modal className="max-w-none" title={t('viewer.overview')} onClose={onClose} closeLabel={t('common.close')}>
        <ol
          dir={rtl ? 'rtl' : 'ltr'}
          className={`grid gap-2 ${thumb ? 'grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(3rem,1fr))]'}`}
        >
          {Array.from({ length: count }, (_, i) => (
            <li key={i}>
              <button
                ref={i === at ? cur : undefined}
                type="button"
                aria-current={i === at ? 'page' : undefined}
                aria-label={t('viewer.pageOf', { page: i + 1, count })}
                onClick={() => onPick(i)}
                className={`grid w-full gap-1 rounded-md p-1 text-center text-xs tabular-nums hover:bg-bg-hover ${i === at ? 'bg-bg-hover text-accent ring-2 ring-accent' : 'text-t-muted'}`}
              >
                {thumb && (
                  <img
                    src={thumb(i)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="aspect-[2/3] w-full rounded-sm bg-black object-cover"
                  />
                )}
                {i + 1}
              </button>
            </li>
          ))}
        </ol>
      </Modal>
    </Dialog>
  )
}

/** A page picture, fitted to the height or the width of the reader. */
export function PageImage({ src, fit, alt }: { src: string; fit: 'width' | 'height'; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
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

/** The book after this one in its folder, for the end of a volume. */
export function useNextBook(server: number, path: string) {
  const folder = useQuery(folderOf(server, path))
  const books = (folder.data ?? []).filter((e) => !e.isDir && isBook(e.name)).sort(byName)
  const i = books.findIndex((e) => e.path === path)
  return i >= 0 && i + 1 < books.length ? viewHref(server, books[i + 1].path) : undefined
}

function BookView({ server, path }: { server: number; path: string }) {
  const { t } = useTranslation()
  const nextHref = useNextBook(server, path)
  const book = useQuery({
    queryKey: ['read-open', server, path],
    queryFn: () => api.get<ReaderBook>(`/api/read/open?server=${server}&path=${encodeURIComponent(path)}`),
    staleTime: 30 * 60_000,
    retry: false,
  })
  if (book.isPending) return <Loading label={t('viewer.unpacking')} />
  if (book.error) return <Failed error={book.error} />
  const b = book.data
  if (b.kind === 'epub') return <EpubView base={b.base} server={server} path={path} />
  if (b.kind === 'sheet') return <SheetView base={b.base} path={path} />
  const pages = b.pages ?? []
  return (
    <Paged
      count={pages.length}
      page={`viewer.page:${server}:${path}`}
      done={doneKey(server, path)}
      direction="manga"
      label={path.split('/').pop() ?? ''}
      nextHref={nextHref}
      preload={(i) => warm(bookUrl(b.base, pages[i]))}
      thumb={(i) => bookUrl(b.base, pages[i])}
      render={(i, fit) => (
        <PageImage
          src={bookUrl(b.base, pages[i])}
          fit={fit}
          alt={t('viewer.pageOf', { page: i + 1, count: pages.length })}
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

const EPUB_MIN = 70
const EPUB_MAX = 200

/**
 * An EPUB, one chapter at a time, each in a sandboxed frame: the book's
 * markup is someone else's, so it gets no script and no origin. The frame
 * scrolls the chapter itself; the bar turns chapters.
 */
function EpubView({ base, server, path }: { base: string; server: number; path: string }) {
  const { t } = useTranslation()
  const data = useQuery({ queryKey: ['epub', base], queryFn: () => loadEpub(base), staleTime: Infinity })
  const [at, setAt] = useStored<number>(`viewer.chapter:${server}:${path}`, 0)
  // most books are black on white; this turns the page around for the dark
  const [night, setNight] = useStored<string>('viewer.night', '0')
  // the frame has no origin to style into, so the type grows by zooming it,
  // which also narrows the column the chapter wraps in
  const [size, setSize] = useStored<number>('viewer.epubSize', 100)
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
  if (data.isPending) return <Loading />
  if (data.error) return <Failed error={data.error} />
  const ch = data.data.chapters
  if (!ch.length) return <Failed error={new Error(t('viewer.noChapters'))} />
  const i = Math.min(at, ch.length - 1)
  const labelOf = (c: EpubChapter, n: number) => c.label || t('viewer.chapterN', { n: n + 1 })
  const contents = (
    <ol className="grid gap-0.5 text-sm">
      {ch.map((c, n) => (
        <li key={c.href}>
          <button
            type="button"
            aria-current={n === i ? 'page' : undefined}
            onClick={() => setAt(n)}
            className={`w-full rounded-md px-2 py-1.5 text-left hover:bg-bg-hover ${n === i ? 'bg-bg-hover text-accent' : ''}`}
          >
            {labelOf(c, n)}
          </button>
        </li>
      ))}
    </ol>
  )
  return (
    <div className="flex min-h-0 flex-1 gap-3">
      {/* the contents beside the page on a wide screen; a picker on a phone */}
      <nav aria-label={t('viewer.contents')} className="hidden w-64 shrink-0 overflow-y-auto lg:block">
        {contents}
      </nav>
      <Panel className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <iframe
          key={ch[i].href}
          title={labelOf(ch[i], i)}
          src={bookUrl(base, ch[i].href)}
          sandbox=""
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
          style={{ zoom: `${size}%`, filter: night === '1' ? 'invert(1) hue-rotate(180deg)' : undefined }}
        />
        <Toolbar className="border-t border-border-subtle p-2">
          <IconButton aria-label={t('viewer.prevChapter')} onClick={() => setAt(i - 1)} disabled={i === 0}>
            <SkipBack aria-hidden />
          </IconButton>
          <Select
            size="sm"
            wrapperClassName="min-w-0 flex-1 lg:hidden!"
            aria-label={t('viewer.contents')}
            value={i}
            onChange={(e) => setAt(Number(e.target.value))}
          >
            {ch.map((c, n) => (
              <option key={c.href} value={n}>
                {labelOf(c, n)}
              </option>
            ))}
          </Select>
          <span className="hidden min-w-0 flex-1 truncate text-sm lg:block">{labelOf(ch[i], i)}</span>
          <span className="font-mono text-xs tabular-nums text-t-muted">
            {i + 1}/{ch.length}
          </span>
          <IconButton aria-label={t('viewer.nextChapter')} onClick={() => setAt(i + 1)} disabled={i >= ch.length - 1}>
            <SkipForward aria-hidden />
          </IconButton>
          <IconButton
            aria-label={t('viewer.smaller')}
            title={t('viewer.smaller')}
            onClick={() => setSize(size - 10)}
            disabled={size <= EPUB_MIN}
          >
            <AArrowDown aria-hidden />
          </IconButton>
          <IconButton
            aria-label={t('viewer.larger')}
            title={t('viewer.larger')}
            onClick={() => setSize(size + 10)}
            disabled={size >= EPUB_MAX}
          >
            <AArrowUp aria-hidden />
          </IconButton>
          <IconButton
            aria-label={t('viewer.night')}
            title={t('viewer.night')}
            aria-pressed={night === '1'}
            onClick={() => setNight(night === '1' ? '0' : '1')}
          >
            <MoonStar aria-hidden />
          </IconButton>
        </Toolbar>
      </Panel>
    </div>
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

/** A spreadsheet's values, one sheet at a time. Formulas show their last result. */
function SheetView({ base, path }: { base: string; path: string }) {
  const { t } = useTranslation()
  const data = useQuery({ queryKey: ['sheets', base], queryFn: () => loadSheets(base, path), staleTime: Infinity })
  const [at, setAt] = useState(0)
  if (data.isPending) return <Loading />
  if (data.error) return <Failed error={data.error} />
  const sheets = data.data
  const sheet = sheets[Math.min(at, sheets.length - 1)]
  if (!sheet) return <Failed error={new Error(t('viewer.emptySheet'))} />
  const width = Math.max(0, ...sheet.rows.map((r) => r.length))
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {sheets.length > 1 && (
        <Tabs scroll aria-label={t('viewer.sheets')}>
          {sheets.map((s, n) => (
            <Tab key={s.name + n} selected={n === at} onClick={() => setAt(n)}>
              {s.name || t('viewer.sheetN', { n: n + 1 })}
            </Tab>
          ))}
        </Tabs>
      )}
      <Panel className="min-h-0 flex-1 overflow-auto">
        <table className="t-sheet text-sm">
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
      </Panel>
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
  if (folder.isPending) return <Loading />
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
  if (text.isPending) return <Loading />
  if (text.error) return <Failed error={text.error} />
  const art = /\.(nfo|diz)$/i.test(name)
  return (
    <Panel
      className="min-h-0 flex-1 overflow-auto p-4"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region has to take focus to scroll by keyboard
      tabIndex={0}
      role="region"
      aria-label={name}
    >
      {text.data.cut && <p className="mb-3 text-sm text-t-muted">{t('viewer.cut')}</p>}
      {/\.md$/i.test(name) ? (
        <div className="max-w-prose">
          <Markdown text={text.data.text} />
        </div>
      ) : (
        <pre className={`font-mono text-sm ${art ? 't-nfo whitespace-pre' : 'whitespace-pre-wrap wrap-break-word'}`}>
          {text.data.text}
        </pre>
      )}
    </Panel>
  )
}

/**
 * A track and the rest of its folder as the queue: the next one starts when
 * one ends. The sound itself plays in the app's one audio element, so it goes
 * on when this page is left; the mini player keeps it in reach meanwhile.
 */
function AudioView({ server, path }: { server: number; path: string }) {
  const { t } = useTranslation()
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

  const q = audio.queue
  const at = q && audio.track?.path === path ? q.at : -1
  const repeatNext: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' }
  const sleepValue = audio.sleep === null ? '' : String(audio.sleep)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      <div className="flex flex-col gap-3 lg:w-80 lg:shrink-0">
        {cover && <Cover src={cover} size="fill" className="aspect-square! w-full max-w-80 self-center" />}
        <input
          type="range"
          min={0}
          max={audio.duration || 0}
          step={1}
          value={Math.min(audio.time, audio.duration || 0)}
          onChange={(e) => audio.seek(Number(e.target.value))}
          aria-label={t('viewer.position')}
          aria-valuetext={`${clock(audio.time)} / ${clock(audio.duration)}`}
          className="t-reader-slider w-full"
        />
        <div className="flex justify-between font-mono text-xs tabular-nums text-t-muted">
          <span>{clock(audio.time)}</span>
          <span>{audio.duration > 0 ? clock(audio.duration) : ''}</span>
        </div>
        <div className="flex items-center justify-center gap-2">
          <IconButton
            aria-label={t(`viewer.repeat_${audio.repeat}`)}
            title={t(`viewer.repeat_${audio.repeat}`)}
            aria-pressed={audio.repeat !== 'off'}
            onClick={() => audio.setRepeat(repeatNext[audio.repeat])}
          >
            {audio.repeat === 'one' ? <Repeat1 aria-hidden /> : <Repeat aria-hidden />}
          </IconButton>
          <IconButton aria-label={t('viewer.prevTrack')} disabled={at <= 0} onClick={() => audio.go(at - 1)}>
            <SkipBack aria-hidden />
          </IconButton>
          <Button
            variant="primary"
            aria-label={audio.paused ? t('player.play') : t('player.pause')}
            onClick={audio.toggle}
            className="size-12 rounded-full! p-0!"
          >
            {audio.paused ? <Play aria-hidden fill="currentColor" /> : <Pause aria-hidden fill="currentColor" />}
          </Button>
          <IconButton
            aria-label={t('viewer.nextTrack')}
            disabled={at < 0 || !q || at >= q.tracks.length - 1}
            onClick={() => audio.go(at + 1)}
          >
            <SkipForward aria-hidden />
          </IconButton>
          <span className="size-9" aria-hidden />
        </div>
        <div className="flex items-center gap-2">
          <Select
            size="sm"
            aria-label={t('viewer.sleep')}
            value={sleepValue}
            onChange={(e) => {
              const v = e.target.value
              audio.setSleep(v === '' ? null : v === 'track' ? 'track' : Number(v))
            }}
          >
            <option value="">{t('viewer.sleepOff')}</option>
            {[15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {t('viewer.sleepIn', { n: m })}
              </option>
            ))}
            <option value="track">{t('viewer.sleepTrack')}</option>
          </Select>
          <Select
            size="sm"
            aria-label={t('viewer.speed')}
            value={audio.rate}
            onChange={(e) => audio.setRate(Number(e.target.value))}
            wrapperClassName="ml-auto"
          >
            {[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </Select>
        </div>
      </div>
      {tracks.length > 1 && (
        <ol aria-label={t('viewer.playlist')} className="min-h-0 flex-1 overflow-y-auto text-sm">
          {tracks.map((e, n) => (
            <li key={e.path}>
              <a
                href={viewHref(server, e.path)}
                onClick={(ev) => {
                  ev.preventDefault()
                  audio.go(n)
                }}
                aria-current={n === at ? 'true' : undefined}
                className={`flex gap-3 rounded-md px-2 py-2 hover:bg-bg-hover ${n === at ? 'bg-bg-hover text-accent' : ''}`}
              >
                <span className="w-6 shrink-0 text-right font-mono tabular-nums text-t-muted">{n + 1}</span>
                <span className="min-w-0 truncate">{e.name}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
