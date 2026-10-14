import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CalendarDays,
  CalendarRange,
  Check,
  GalleryHorizontal,
  Languages,
  LayoutGrid,
  List,
  Pencil,
  Search,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import {
  Button,
  DayScroller,
  DayTimeline,
  EmptyState,
  IconButton,
  localTransition,
  Menu,
  MenuItem,
  PosterBand,
  Rows,
  SectionHeading,
  Segmented,
  SHEET_MQ,
  Slot,
  SwipeDeck,
  TextLink,
  useMediaQuery,
  useMenu,
  useReveal,
} from 'fluid-lycoris'
import { api, mediaTitle, type Watch } from '../api'
import ActionSheet from '../components/ActionSheet'
import Press from '../components/Press'
import { addDays, dayKey, episodeLabel, fileStatus, startOfDay, upcomingAirings, type Airing } from '../airings'
import { countdown } from '../countdown'
import WatchDialog from '../components/WatchDialog'
import { nextVolume } from '../components/playLinks'
import { useWatchActions, watchFields } from '../components/watchActions'
import { useFailToast, useToast } from '../components/toast'
import { useSeriesModal, type SeriesTarget } from '../components/SeriesModal'
import PageActions, { WIDE_MQ } from '../components/PageActions'
import { CoverImg } from '../components/SmartImg'
import { coverSet } from '../images'
import { useAuth, useNow } from '../hooks'
import { usePersistedView } from '../hooks/usePersistedView'
import { WATCH_SORTS, groupWatches } from '../watchGroups'
import {
  calDayHeading,
  checkCell,
  diskName,
  matchesFilter,
  nextCell,
  normalizeFilter,
  tileSub,
  watchName,
  WATCH_FILTERS,
} from '../watchTiles'
import './watches.css'

type CalCategory = 'anime-series' | 'anime-movie' | 'series' | 'movie'
const CAL_CATEGORIES: readonly CalCategory[] = ['anime-series', 'anime-movie', 'series', 'movie']
// case and accents folded, so "chaos" finds "Chäos"
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()

const isToday = (ts: number) => new Date(ts * 1000).toDateString() === new Date().toDateString()
const hm = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
// how long a search waits for the typing to pause before the tiles reflow
const SEARCH_MS = 140
// how long the grid keeps the page-entry rise out after a morph of its own
const MORPH_MS = 1200

interface RowAction {
  key: string
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}

// Watches: the Auto-Sync page. Every watch as a bare cover tile (or a hairline
// row), filtered by what it is doing, and the calendar of what airs when on
// the same data. The list polls, so check results appear live.
export default function Watches() {
  const { t } = useTranslation()
  const { data: watches = [], isLoading } = useQuery<Watch[]>({
    queryKey: ['watches'],
    queryFn: () => api.get('/api/watches'),
    refetchInterval: 10_000,
  })
  const [edit, setEdit] = useState<Watch | null>(null)
  // a long press on a tile opens every action of it in a sheet
  const [more, setMore] = useState<Watch | null>(null)
  const narrow = useMediaQuery(SHEET_MQ)
  const wide = useMediaQuery(WIDE_MQ)
  const { applyPlexStreams, del, save, error, notice } = useWatchActions()
  const toast = useToast()
  const fail = useFailToast()
  // what the actions report goes to the toast, as everywhere else
  useEffect(() => {
    if (error) toast({ message: error })
  }, [error, toast])
  useEffect(() => {
    if (notice) toast({ message: notice })
  }, [notice, toast])

  // one page, three ways to look at it; the grid of covers first
  const [mode, setMode] = usePersistedView(
    'weebsync.watches.mode',
    ['grid', 'list', 'calendar'] as const,
    'grid',
    'view',
  )
  const view = mode === 'calendar' ? 'calendar' : 'tiles'
  // what the watches do: all, still airing, with gaps, finished. The old
  // "attention" address (a dashboard link) lands on the gaps.
  const [rawFilter, setRawFilter] = usePersistedView(
    'weebsync.watches.filter',
    [...WATCH_FILTERS, 'attention'] as const,
    'all',
    'filter',
  )
  const filter = normalizeFilter(rawFilter)
  const [calMode, setCalMode] = usePersistedView(
    'weebsync.watches.calendar',
    ['week', 'agenda', 'poster'] as const,
    'week',
    'cal',
  )
  const [calCat, setCalCat] = useState<'all' | CalCategory>('all')
  const [kind, setKind] = usePersistedView('weebsync.watches.kind', ['video', 'manga'] as const, 'video', 'kind')
  // the order, and with it the sections the tiles fall under; remembered,
  // with its direction (a second pick of the same sort turns it around)
  const [sort, setSort] = usePersistedView('weebsync.watches.sort', WATCH_SORTS, 'next', 'sort')
  const [dir, setDir] = usePersistedView('weebsync.watches.dir', ['asc', 'desc'] as const, 'asc', 'dir')

  // search: a field in the title row on a desktop, a pill growing out of the
  // magnifier over the phone's top bar. The tiles reflow once typing pauses.
  const [query, setQuery] = useState('')
  const [needle, setNeedle] = useState('')
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setNeedle(fold(query.trim())), SEARCH_MS)
    return () => clearTimeout(id)
  }, [query])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.key !== '/' || e.ctrlKey || e.metaKey || el.closest('input, textarea, select, [contenteditable]')) return
      e.preventDefault()
      setSearching(true)
      requestAnimationFrame(() => document.getElementById('watch-search')?.focus())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const closeSearch = () => {
    setQuery('')
    setSearching(false)
  }
  // the desktop title row is the shell's; the field joins it from here
  const [titleRow, setTitleRow] = useState<HTMLElement | null>(null)
  const findTitleRow = useCallback((el: HTMLElement | null) => {
    if (el) setTitleRow(el.closest('main')?.querySelector<HTMLElement>(':scope > .ws-title') ?? null)
  }, [])

  // A filter, a sort, video or manga, grid or list: the tiles move to their
  // new places instead of jumping. Only those on screen get a name, so a long
  // list does not freeze a phone (90 named covers held a Pixel 550 ms), and
  // every box is measured before any name is written, so the layout is read
  // once. The grid holds data-morph meanwhile: the page-entry rise, which the
  // address change would replay, stays out of the morph.
  const grid = useRef<HTMLDivElement>(null)
  const morphTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reorder = (update: () => void) => {
    const g = grid.current
    if (g) {
      g.dataset.morph = ''
      clearTimeout(morphTimer.current)
      morphTimer.current = setTimeout(() => g.removeAttribute('data-morph'), MORPH_MS)
    }
    const name = (on: boolean) => {
      const els = [...document.querySelectorAll<HTMLElement>('[data-wid]')]
      const seen = on ? els.map((el) => el.getBoundingClientRect()).map((r) => r.bottom > 0 && r.top < innerHeight) : []
      els.forEach((el, i) => {
        el.style.viewTransitionName = seen[i] ? `watch-${el.dataset.wid}` : ''
      })
    }
    name(true)
    void localTransition(null, () => {
      flushSync(update)
      name(true)
    }).finally(() => name(false))
  }
  useEffect(() => () => clearTimeout(morphTimer.current), [])

  const hasManga = watches.some((w) => w.category === 'manga')
  const manga = hasManga && kind === 'manga'
  const ofKind = hasManga ? watches.filter((w) => (w.category === 'manga') === manga) : watches
  const navigate = useNavigate()
  // nextVolume treats an unreachable folder as empty, so the toast covers
  // both: a click always answers, even when there is nothing to open
  const read = async (w: Watch) => {
    try {
      const href = await nextVolume(w)
      if (href) navigate(href)
      else toast({ message: t('watch.noVolume') })
    } catch (err) {
      fail(err)
    }
  }
  const { open: openSeries } = useSeriesModal()
  const targetOf = (w: Watch): SeriesTarget => ({
    source: w.mediaSource,
    id: w.media!.id,
    media: w.media,
    watchId: w.id,
    title: w.titleOverride || undefined,
  })
  const showSeries = (w: Watch) => w.media && openSeries(targetOf(w))
  // editing lives in the series page ("Bearbeiten replaces the page"); a
  // watch without a record has no page and keeps the dialog
  const editWatch = (w: Watch) => (w.media ? openSeries(Object.assign(targetOf(w), { edit: true })) : setEdit(w))
  const openTile = (w: Watch) => (w.category === 'manga' ? void read(w) : w.media ? showSeries(w) : setEdit(w))
  // every action of a watch, for the long-press sheet
  // Plex track choices act on the admin's Plex account: an admin's
  const isAdmin = !!useAuth().data?.isAdmin
  const rowActions = (w: Watch): RowAction[] => [
    ...(w.category === 'manga'
      ? [
          {
            key: 'read',
            icon: <BookOpen aria-hidden size="1em" />,
            label: t('watch.read'),
            onClick: () => void read(w),
          },
        ]
      : []),
    { key: 'edit', icon: <Pencil aria-hidden size="1em" />, label: t('servers.edit'), onClick: () => editWatch(w) },
    ...(isAdmin && (w.plexAudioLang || w.plexSubLang)
      ? [
          {
            key: 'plex',
            icon: <Languages aria-hidden size="1em" />,
            label: t('watch.plexApplyAll'),
            onClick: () => void applyPlexStreams(w.id),
          },
        ]
      : []),
    ...((w.missing?.length ?? 0) > 0 && w.media
      ? [
          {
            key: 'gaps',
            icon: <TriangleAlert aria-hidden size="1em" />,
            label: t('watch.gapsAction'),
            onClick: () => openSeries({ ...targetOf(w), tab: 'episodes' }),
          },
        ]
      : []),
    {
      key: 'delete',
      icon: <Trash2 aria-hidden size="1em" />,
      label: t('servers.delete'),
      onClick: () => void del(w),
      danger: true,
    },
  ]

  // the clock behind every countdown: a second while today's calendar
  // entries count down, a minute otherwise
  const hasToday = watches.some((w) => (w.airings ?? []).some((a) => isToday(a.at) && a.at * 1000 > Date.now()))
  const now = useNow(view === 'calendar' && hasToday ? 1000 : 60_000)

  // ── the tiles ──
  // the search: title or folder, case and accents folded
  const matches = (w: Watch) => !needle || fold(`${watchName(w)} ${w.remotePath}`).includes(needle)
  const searched = ofKind.filter(matches)
  const shown = searched.filter((w) => manga || matchesFilter(w, filter))
  const groups = groupWatches(shown, sort, dir, now)
  // the filter's counts, over what the search leaves
  const filterCount = (f: (typeof WATCH_FILTERS)[number]) => searched.filter((w) => matchesFilter(w, f)).length
  const layout = mode === 'list' ? 'list' : 'grid'

  // Tiles below the first screen rise as they scroll in (useReveal); those on
  // it rise with the page. Every box is read first, then the marks written.
  useLayoutEffect(() => {
    const g = grid.current
    if (!g) return
    const items = [...g.querySelectorAll<HTMLElement>('.w-grid > li')]
    const below = items.map((el) => el.getBoundingClientRect().top >= innerHeight)
    items.forEach((el, i) => el.classList.toggle('t-reveal', below[i] || el.dataset.in !== undefined))
  }, [shown.length, layout, view])
  useReveal(grid, '.t-reveal', `${shown.length}-${layout}-${view}`)

  // ── the calendar ──
  const calEvents = upcomingAirings(watches, now)
  const calCats = CAL_CATEGORIES.filter((c) => calEvents.some((e) => e.watch.category === c))
  const calShown = calCat === 'all' ? calEvents : calEvents.filter((e) => e.watch.category === calCat)
  const today = startOfDay(new Date(now))
  // The calendar counts in days from now: day 0 is today, and the band, the
  // panel and the desktop grid all read from that one number.
  const [dayIdx, setDayIdx] = useState(0)
  const selectedDate = addDays(today, dayIdx)
  const selectedDay = dayKey(selectedDate)
  const byDay = new Map<string, Airing[]>()
  for (const e of calShown) {
    const k = dayKey(new Date(e.at * 1000))
    byDay.set(k, [...(byDay.get(k) ?? []), e])
  }
  // the desktop grid: the picked day in the middle, three days either side
  const weekDays = (i: number) => Array.from({ length: 7 }, (_, d) => addDays(today, i - 3 + d))
  // The grid hides days by its own width (.t-week: 7 columns, 5 below 1892px,
  // 3 below 1348px), so "nothing this week" is judged on the days it shows.
  const [weekCols, setWeekCols] = useState(7)
  const weekBox = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width
      setWeekCols(w < 1348 ? 3 : w < 1892 ? 5 : 7)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const weekHasAny = (i: number) =>
    weekDays(i)
      .slice((7 - weekCols) / 2, (7 + weekCols) / 2)
      .some((d) => byDay.has(dayKey(d)))
  const nextAfter = calShown.find((e) => e.at * 1000 >= addDays(selectedDate, 1).getTime())
  // A week of the past leads in, four weeks ahead at the least, a year at most
  const PAST_DAYS = 7
  const lastAt = calShown.length ? calShown[calShown.length - 1].at * 1000 : 0
  const span = Math.min(400, Math.max(28, Math.ceil((lastAt - today.getTime()) / 86_400_000) + 7))
  const bandDays = Array.from({ length: span + 1 + PAST_DAYS }, (_, i) => addDays(today, i - PAST_DAYS))
  const dayIdxOf = (d: Date) => Math.round((startOfDay(d).getTime() - today.getTime()) / 86_400_000)
  const gapLabel = (minutes: number) =>
    minutes >= 60
      ? t('watch.week.gapHours', { h: Math.round(minutes / 60) })
      : t('watch.week.gapMinutes', { m: Math.round(minutes) })
  // the agenda: every release still ahead, grouped by day
  const calGroups: { day: Date; items: Airing[] }[] = []
  for (const e of calShown) {
    if (e.at * 1000 <= now) continue
    const day = startOfDay(new Date(e.at * 1000))
    const g = calGroups.find((x) => x.day.getTime() === day.getTime())
    if (g) g.items.push(e)
    else calGroups.push({ day, items: [e] })
  }
  const entryKey = (e: Airing) => `${e.watch.id}-${e.episode}-${e.at}-${e.dub ?? ''}`
  const nowLabel = t('watch.week.now', {
    time: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  })
  // The file behind an entry, under its episode line: on disk, on the
  // server, or when it should be there.
  const fileLine = (e: Airing) => {
    const st = fileStatus(e, now)
    if (!st) return null
    if (st.kind === 'have')
      return (
        <span className="w-file" data-kind="have">
          <Check aria-hidden size="0.9em" className="mr-1 inline align-[-0.1em]" />
          {t('watch.fileHave')}
        </span>
      )
    const d = new Date((st.at ?? 0) * 1000)
    const time =
      (startOfDay(d).getTime() === startOfDay(new Date(e.at * 1000)).getTime()
        ? ''
        : `${d.toLocaleDateString([], { weekday: 'short' })} `) + hm(st.at ?? 0)
    const key = { onServer: 'watch.fileOnServer', expected: 'watch.fileExpected', late: 'watch.fileLate' }[st.kind]
    return (
      <span className="w-file" data-kind={st.kind} title={st.kind === 'onServer' ? undefined : t('watch.fileEstimate')}>
        {t(key, { time })}
      </span>
    )
  }
  // one release as a row: time, title and episode, how far off it is
  const entry = (e: Airing) => {
    const w = e.watch
    const past = e.at * 1000 <= now
    return (
      <Press onLongPress={() => setMore(w)}>
        <button type="button" className="w-ag" disabled={!w.media} onClick={() => showSeries(w)}>
          <CoverImg
            className="w-ag-cov"
            set={coverSet(w.media?.coverImage)}
            tint={w.media?.coverImage?.color}
            sizes="2.75rem"
          />
          <time
            dateTime={new Date(e.at * 1000).toISOString()}
            title={w.mediaSource?.startsWith('tmdb') ? undefined : `${jst(e.at)} JST`}
          >
            {hm(e.at)}
          </time>
          <span className="w-ag-t">
            <strong>{watchName(w)}</strong>
            <span title={e.est ? t('watch.dubEstimate') : undefined}>{episodeLabel(t, e)}</span>
            {fileLine(e)}
          </span>
          <span className="w-ag-state" data-tone={past && e.have ? 'ok' : undefined}>
            {past ? t('watch.cal.aired') : countdown(t, e.at, isToday(e.at), now)}
          </span>
        </button>
      </Press>
    )
  }
  const rows = (items: Airing[]) => (
    <Rows dense>
      {items.map((e) => (
        <li key={entryKey(e)} className="t-row">
          {entry(e)}
        </li>
      ))}
    </Rows>
  )
  const timeline = (items: Airing[], isNow: boolean) => (
    <DayTimeline
      entries={items.map((e) => ({ key: entryKey(e), at: e.at, node: entry(e) }))}
      now={isNow ? now : undefined}
      nowLabel={nowLabel}
      gapLabel={gapLabel}
    />
  )
  const jumpNext = (show: boolean) =>
    show &&
    nextAfter && (
      <TextLink tone="accent-2" onClick={() => setDayIdx(dayIdxOf(new Date(nextAfter.at * 1000)))}>
        {t('watch.week.jump')}
      </TextLink>
    )

  // ── the tools row ──
  const { open: sortOpen, setOpen: setSortOpen, ref: sortRef, anchor: sortAnchor, anchorStyle: sortStyle } = useMenu()
  const SORT_OPTS = [
    { v: 'next', k: 'watch.sortNext' },
    { v: 'status', k: 'watch.sortStatus' },
    { v: 'name', k: 'watch.sortName' },
    { v: 'last', k: 'watch.sortLast' },
    { v: 'season', k: 'watch.sortSeason' },
  ] as const
  const sortLabel = t(SORT_OPTS.find((o) => o.v === sort)?.k ?? 'watch.sortNext')
  const Arrow = dir === 'asc' ? ArrowUp : ArrowDown
  const icon = (Icon: typeof List) => <Icon aria-hidden />

  const searchField = (bar: boolean) => (
    <label className={`w-search ${bar ? 'w-search--bar' : ''}`} style={bar ? undefined : { marginLeft: 'auto' }}>
      <Search aria-hidden />
      <span className="sr-only">{t('watch.search')}</span>
      <input
        id="watch-search"
        type="search"
        value={query}
        autoComplete="off"
        autoFocus={bar}
        placeholder={t('watch.searchPlaceholder')}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeSearch()
        }}
      />
      {bar && (
        <button type="button" className="w-search-x" aria-label={t('watch.searchClose')} onClick={closeSearch}>
          <X aria-hidden size="1.25em" />
        </button>
      )}
    </label>
  )

  return (
    <div ref={findTitleRow} className="w-page">
      {view === 'tiles' &&
        watches.length > 0 &&
        (wide ? (
          titleRow && createPortal(searchField(false), titleRow)
        ) : (
          <PageActions>
            {searching ? (
              searchField(true)
            ) : (
              <IconButton aria-label={t('watch.search')} onClick={() => setSearching(true)}>
                <Search aria-hidden size="1.25em" />
              </IconButton>
            )}
          </PageActions>
        ))}

      {watches.length > 0 && (
        <div className="w-tools">
          {/* video or manga: only once there is a manga to tell apart */}
          {view === 'tiles' && hasManga && (
            <Segmented
              aria-label={t('watch.kind')}
              className="w-kind"
              value={kind}
              onChange={(k) => reorder(() => setKind(k))}
              options={[
                { value: 'video', label: t('watch.kindVideo') },
                { value: 'manga', label: t('watch.kindManga') },
              ]}
            />
          )}
          {view === 'tiles' && !manga && (
            <Segmented
              aria-label={t('watch.filter.label')}
              className="w-filter"
              value={filter}
              onChange={(f) => reorder(() => setRawFilter(f))}
              options={WATCH_FILTERS.map((f) => ({
                value: f,
                label: (
                  <>
                    {t(`watch.filter.${f}`)}
                    <span className="w-count">{filterCount(f)}</span>
                  </>
                ),
              }))}
            />
          )}
          <div className="w-end">
            {view === 'calendar' && calShown.length > 0 && (
              <Segmented
                aria-label={t('watch.calMode')}
                className="w-icons"
                value={calMode}
                onChange={setCalMode}
                options={(
                  [
                    ['week', CalendarRange, 'watch.calWeek'],
                    ['agenda', List, 'watch.calAgenda'],
                    ['poster', GalleryHorizontal, 'watch.calPoster'],
                  ] as const
                ).map(([v, Icon, k]) => ({ value: v, 'aria-label': t(k), label: icon(Icon) }))}
              />
            )}
            {view === 'tiles' && (
              <div className="relative" ref={sortRef} style={sortStyle}>
                <button
                  type="button"
                  className="w-sort"
                  aria-haspopup="listbox"
                  aria-expanded={sortOpen}
                  onClick={() => setSortOpen((o) => !o)}
                >
                  <SlidersHorizontal aria-hidden size="1rem" />
                  <span className="sr-only">{t('watch.sortBy')}: </span>
                  {sortLabel}
                  <Arrow
                    aria-label={t(dir === 'asc' ? 'watch.sortAsc' : 'watch.sortDesc')}
                    size="0.9375rem"
                    className="w-sort-dir"
                  />
                </button>
                {sortOpen && (
                  <Menu anchor={sortAnchor} placement="bottom-end" aria-label={t('watch.sortBy')}>
                    <li role="presentation" className="w-sort-cap">
                      {t('watch.sortBy')}
                    </li>
                    {SORT_OPTS.map((o) => (
                      <MenuItem
                        key={o.v}
                        selected={sort === o.v}
                        trailing={
                          sort === o.v ? (
                            <Arrow aria-hidden size="1.1em" className="shrink-0 text-accent-2" />
                          ) : undefined
                        }
                        onClick={() => {
                          // the same sort again turns its direction around
                          reorder(() => (sort === o.v ? setDir(dir === 'asc' ? 'desc' : 'asc') : setSort(o.v)))
                          setSortOpen(false)
                        }}
                      >
                        <span className="w-sort-opt">
                          {t(o.k)}
                          <small>{t(`watch.sortHint.${o.v}`)}</small>
                        </span>
                      </MenuItem>
                    ))}
                  </Menu>
                )}
              </div>
            )}
            <Segmented
              aria-label={t('watch.view')}
              className="w-icons"
              value={mode}
              onChange={(m) => (m === 'calendar' || mode === 'calendar' ? setMode(m) : reorder(() => setMode(m)))}
              options={(
                [
                  ['grid', LayoutGrid, 'watch.viewGrid'],
                  ['list', List, 'watch.viewList'],
                  ['calendar', CalendarDays, 'watch.viewCalendar'],
                ] as const
              ).map(([v, Icon, k]) => ({ value: v, 'aria-label': t(k), label: icon(Icon) }))}
            />
          </div>
        </div>
      )}

      {/* the calendar's categories: plain links, the picked one in teal */}
      {view === 'calendar' && calCats.length > 1 && (
        <div role="group" aria-label={t('watch.calFilter')} className="w-cats">
          {(['all', ...calCats] as const).map((c) => (
            <TextLink key={c} aria-pressed={calCat === c} onClick={() => setCalCat(c)}>
              {c === 'all' ? t('watch.calAll') : t(`watch.cat.${c}`)}
            </TextLink>
          ))}
        </div>
      )}

      {isLoading ? (
        // the tiles' real heights, so nothing below jumps when they arrive
        <ul className="w-grid w-skel" aria-busy="true" aria-label={t('watch.title')}>
          {Array.from({ length: 12 }, (_, i) => (
            <li key={i} aria-hidden>
              <span className="w-cover t-cover block" />
              <span className="w-bar" />
              <span className="w-bar" />
            </li>
          ))}
        </ul>
      ) : watches.length === 0 ? (
        <EmptyState>
          <Trans i18nKey="watch.empty" components={{ go: <Link to="/files" className="t-link t-link--2" /> }} />
        </EmptyState>
      ) : view === 'calendar' ? (
        calShown.length === 0 ? (
          <EmptyState>{t('watch.calEmpty')}</EmptyState>
        ) : calMode === 'poster' ? (
          <PosterCalendar key={calCat} events={calShown} now={now} onOpen={showSeries} />
        ) : calMode === 'agenda' ? (
          <div className="flex flex-col gap-6">
            {calGroups.map((g) => (
              <CalDay key={g.day.getTime()} heading={calDayHeading(t, g.day, today)}>
                {rows(g.items)}
              </CalDay>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* the band scrubs through the days; the arrows jump a week, the
                button between them returns to today */}
            <DayScroller
              days={bandDays.map((d) => ({
                key: dayKey(d),
                weekday: d.toLocaleDateString([], { weekday: 'short' }),
                day: d.getDate(),
                count: byDay.get(dayKey(d))?.length,
                today: d.getTime() === today.getTime(),
                past: d.getTime() < today.getTime(),
                label: t('watch.week.dayLabel', {
                  date: d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }),
                  count: byDay.get(dayKey(d))?.length ?? 0,
                }),
              }))}
              selected={selectedDay}
              onSelect={(k) => setDayIdx(dayIdxOf(new Date(k + 'T00:00')))}
              step={dayIdx}
              label={calDayHeading(t, selectedDate, today)}
              onPrev={dayIdx > -PAST_DAYS ? () => setDayIdx(Math.max(-PAST_DAYS, dayIdx - 7)) : undefined}
              onNext={() => setDayIdx(dayIdx + 7)}
              onToday={dayIdx !== 0 ? () => setDayIdx(0) : undefined}
              labels={{
                prev: t('watch.week.prev'),
                next: t('watch.week.next'),
                today: t('watch.week.today'),
                strip: t('watch.week.strip'),
              }}
            />
            {!wide ? (
              // the phone shows one day and pages days
              <SwipeDeck index={dayIdx} onIndex={setDayIdx} canPrev={dayIdx > -PAST_DAYS} mouse>
                {(i) => {
                  const d = addDays(today, i)
                  const items = byDay.get(dayKey(d)) ?? []
                  return (
                    <CalDay quiet heading={calDayHeading(t, d, today)} today={i === 0}>
                      {items.length === 0 ? (
                        <p className="w-free">
                          {t('watch.cal.free')} {jumpNext(i === dayIdx)}
                        </p>
                      ) : (
                        // the day as a time axis, with now drifting down it on today
                        timeline(items, d.getTime() === today.getTime())
                      )}
                    </CalDay>
                  )
                }}
              </SwipeDeck>
            ) : (
              <div ref={weekBox}>
                <SwipeDeck index={dayIdx} onIndex={setDayIdx} step={7} canPrev={dayIdx - 7 >= -PAST_DAYS} mouse>
                  {(i) =>
                    !weekHasAny(i) ? (
                      <EmptyState>
                        <p>{t('watch.week.empty')}</p>
                        {jumpNext(i === dayIdx)}
                      </EmptyState>
                    ) : (
                      // the days around the picked one, as many as fit (.t-week)
                      <div className="t-week w-week">
                        <div className="t-week__grid">
                          {weekDays(i).map((d) => {
                            const items = byDay.get(dayKey(d)) ?? []
                            const isTodayCol = d.getTime() === today.getTime()
                            return (
                              <CalDay
                                key={dayKey(d)}
                                heading={calDayHeading(t, d, today)}
                                today={isTodayCol}
                                past={!isTodayCol && d.getTime() < today.getTime()}
                              >
                                {items.length === 0 ? (
                                  <p className="w-free">{t('watch.cal.free')}</p>
                                ) : isTodayCol ? (
                                  timeline(items, true)
                                ) : (
                                  rows(items)
                                )}
                              </CalDay>
                            )
                          })}
                        </div>
                      </div>
                    )
                  }
                </SwipeDeck>
              </div>
            )}
          </div>
        )
      ) : (
        <>
          <div ref={grid} className="w-groups">
            {groups.map((g, gi) => (
              <section key={g.key} className="w-group" aria-label={t(g.label, g.values)}>
                <SectionHeading
                  level={3}
                  tone={g.tone}
                  className="w-group-h"
                  title={t(g.label, g.values)}
                  action={<span className="w-group-n">{g.watches.length}</span>}
                />
                <ul className={`w-grid ${layout === 'list' ? 'as-list' : ''}`} data-rise="">
                  {g.watches.map((w, i) => (
                    <WatchTile
                      key={w.id}
                      watch={w}
                      list={layout === 'list'}
                      eager={gi === 0 && i < 12}
                      now={now}
                      onOpen={() => openTile(w)}
                      onMore={narrow ? () => setMore(w) : undefined}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {shown.length === 0 && <p className="t-empty">{t('watch.searchEmpty')}</p>}
        </>
      )}

      {edit && (
        <WatchDialog
          title={t('watch.editTitle')}
          serverId={edit.serverId}
          watchId={edit.id}
          initial={watchFields(edit)}
          onSave={(f) => save(edit.id, f)}
          onClose={() => setEdit(null)}
        />
      )}
      {more && <ActionSheet title={watchName(more)} actions={rowActions(more)} onClose={() => setMore(null)} />}
    </div>
  )
}

// a release in Japan's time, for the hover on a time
const jst = (ts: number) =>
  new Date(ts * 1000).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  })

// A calendar day: a section heading with the teal marker, its releases under it.
function CalDay({
  heading,
  quiet,
  today,
  past,
  children,
}: {
  heading: string
  /** the phone's day under the band, which already names it */
  quiet?: boolean
  today?: boolean
  past?: boolean
  children: ReactNode
}) {
  return (
    <section className="w-day" aria-current={today ? 'date' : undefined} data-past={past ? '' : undefined}>
      {quiet ? <h2 className="sr-only">{heading}</h2> : <SectionHeading title={heading} tone="accent-2" />}
      {children}
    </section>
  )
}

// A watch as a bare cover tile, the whole tile one button into the series
// page; in the list the same markup lies as a hairline row with three more
// columns on a desktop.
function WatchTile({
  watch: w,
  list,
  eager,
  now,
  onOpen,
  onMore,
}: {
  watch: Watch
  list: boolean
  eager: boolean
  now: number
  onOpen: () => void
  onMore?: () => void
}) {
  const { t } = useTranslation()
  const name = watchName(w)
  const sub = tileSub(t, w)
  return (
    <Press as="li" data-wid={w.id} onLongPress={onMore}>
      <button type="button" className="w-tile" onClick={onOpen}>
        <CoverImg
          className="w-cover"
          set={coverSet(w.media?.coverImage)}
          tint={w.media?.coverImage?.color}
          title={name}
          sizes={list ? '3rem' : '(min-width: 64rem) 11rem, (min-width: 40rem) 10rem, 33vw'}
          eager={eager}
        />
        <span className="w-name">{name}</span>
        <span className="w-sub" data-tone={sub.tone}>
          {sub.text}
          {sub.loading && (
            <>
              {' · '}
              <span className="w-acc">{t('watch.tile.loading')}</span>
            </>
          )}
        </span>
        {list && (
          <>
            <span className="w-col w-c-next">{nextCell(t, w, now)}</span>
            <span className="w-col w-c-disk">{diskName(w.localPath)}</span>
            <span className="w-col w-c-check">{checkCell(t, w)}</span>
          </>
        )}
      </button>
    </Press>
  )
}

// The calendar as a band of posters: every release in order, opening on the
// next one to air. Under the band the middle poster's title, episode, time and
// countdown roll over as the band moves.
function PosterCalendar({ events, now, onOpen }: { events: Airing[]; now: number; onOpen: (w: Watch) => void }) {
  const { t } = useTranslation()
  const first = Math.max(
    0,
    events.findIndex((e) => e.at * 1000 >= now),
  )
  const dayStart = startOfDay(new Date(now)).getTime()
  const [at, setAt] = useState(first)
  const i = Math.min(at, events.length - 1)
  const e = events[i]
  const onToday = i === first
  const nameOf = (x: Airing) =>
    x.watch.titleOverride || mediaTitle(x.watch.media, x.watch.remotePath.split('/').pop() || '')
  const when = (ts: number) => {
    const d = new Date(ts * 1000)
    const day =
      startOfDay(d).getTime() === dayStart
        ? t('watch.week.today')
        : d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: '2-digit' })
    return `${day} ${hm(ts)}`
  }
  const arrow = (label: string, to: number, path: string) => (
    <IconButton
      aria-label={label}
      title={label}
      className="shrink-0 disabled:cursor-default disabled:opacity-40"
      disabled={to < 0 || to >= events.length}
      onClick={() => setAt(to)}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="1.2em"
        height="1.2em"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d={path} />
      </svg>
    </IconButton>
  )
  return (
    <section className="flex min-w-0 flex-col gap-1" aria-label={t('watch.calPoster')}>
      <PosterBand
        label={t('watch.calPoster')}
        items={events.map((x) => ({
          key: `${x.watch.id}-${x.episode}-${x.at}-${x.dub ?? ''}`,
          cover: x.watch.media?.coverImage?.extraLarge || x.watch.media?.coverImage?.large,
          tint: x.watch.media?.coverImage?.color ?? undefined,
          chip: hm(x.at),
          label: `${nameOf(x)}, ${episodeLabel(t, x)}, ${when(x.at)}`,
          past: x.at * 1000 < now,
        }))}
        index={i}
        onIndex={setAt}
        onOpen={(k) => events[k].watch.media && onOpen(events[k].watch)}
      />
      {e && (
        <div className="flex flex-col items-center gap-0.5 text-center">
          <span aria-live="polite" className="sr-only">
            {`${nameOf(e)}, ${episodeLabel(t, e)}, ${when(e.at)}`}
          </span>
          <div className="flex max-w-full flex-col items-center gap-0.5">
            <Slot step={i} className="max-w-full">
              <h2 className="truncate font-display text-base font-semibold lg:text-lg">{nameOf(e)}</h2>
            </Slot>
            <Slot step={i} className="max-w-full">
              <p className="font-mono text-xs text-balance text-t-secondary">
                {episodeLabel(t, e)} ·{' '}
                <span className="font-mono text-xs whitespace-nowrap text-accent-2">{when(e.at)}</span>
                {e.at * 1000 >= now && (
                  <>
                    {' · '}
                    <span className="font-mono text-xs whitespace-nowrap text-t-primary">
                      {countdown(t, e.at, isToday(e.at), now)}
                    </span>
                  </>
                )}
              </p>
            </Slot>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            {arrow(t('watch.calPosterPrev'), i - 1, 'm15 6-6 6 6 6')}
            <Button
              size="sm"
              className="disabled:cursor-default disabled:opacity-40"
              disabled={onToday}
              onClick={() => setAt(first)}
            >
              {t('watch.week.today')}
            </Button>
            {arrow(t('watch.calPosterNext'), i + 1, 'm9 6 6 6-6 6')}
          </div>
        </div>
      )}
    </section>
  )
}
