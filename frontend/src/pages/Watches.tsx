import { useState, type ReactNode } from 'react'
import {
  ArrowUpDown,
  CalendarDays,
  CalendarRange,
  Check,
  Clock,
  Download,
  Ellipsis,
  Eye,
  FolderClock,
  Languages,
  LayoutGrid,
  Tv,
  List,
  Pencil,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Upload,
  type LucideIcon,
} from 'lucide-react'

// icon per status group divider (syncing / idle / waiting / complete)
const GROUP_ICON: Record<string, LucideIcon> = {
  syncing: Download,
  idle: Eye,
  waiting: Clock,
  complete: Check,
}
import { useQuery } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  Badge,
  Button,
  CalendarDay,
  DayTimeline,
  CalendarEntry,
  DayScroller,
  Cover,
  Dialog,
  Divider,
  EmptyState,
  IconButton,
  MediaCard,
  Menu,
  MenuItem,
  Panel,
  Progress,
  Segmented,
  SHEET_MQ,
  SwipeDeck,
  useMediaQuery,
  useMenu,
} from '@weebsync/design-system'
import { api, fmtMissing, mediaTitle, type Watch } from '../api'
import { addDays, dayKey, localeFirstDay, startOfDay, startOfWeek, upcomingAirings, type Airing } from '../airings'
import { countdown } from '../countdown'
import WatchDialog from '../components/WatchDialog'
import { useWatchActions, watchFields } from '../components/watchActions'
import { useSeriesModal } from '../components/SeriesModal'
import PageActions, { WIDE_MQ } from '../components/PageActions'
import { useNow } from '../hooks'
import { usePersistedView } from '../hooks/usePersistedView'
import { SkeletonCards } from '../components/Loading'

type CalCategory = 'anime-series' | 'anime-movie' | 'series' | 'movie'
const CAL_CATEGORIES: readonly CalCategory[] = ['anime-series', 'anime-movie', 'series', 'movie']

// Watches: persistent auto-sync overview. Each watch re-checks its remote
// folder on an interval; the list polls so check results appear live.
export default function Watches() {
  const { t } = useTranslation()
  const { data: watches = [], isLoading } = useQuery<Watch[]>({
    queryKey: ['watches'],
    queryFn: () => api.get('/api/watches'),
    refetchInterval: 10_000,
  })
  const [edit, setEdit] = useState<Watch | null>(null)
  // on a phone a card shows Check now and one More button; the rest of its
  // actions open in a dialog, so a card stays two lines instead of four
  const [more, setMore] = useState<Watch | null>(null)
  const narrow = useMediaQuery(SHEET_MQ)
  // the same requests the title card runs, so both refresh the same list
  const { check, applyPlexStreams, del, save, error, notice } = useWatchActions()

  // sqlite datetimes are UTC without zone suffix
  const ago = (dt: string) => {
    if (!dt) return t('watch.never')
    const min = Math.max(0, Math.round((Date.now() - Date.parse(dt.replace(' ', 'T') + 'Z')) / 60_000))
    return t('watch.minAgo', { count: min })
  }
  // AniList airingAt is an absolute unix time; render in the viewer's zone
  // (or a named zone like Asia/Tokyo for the JST hover)
  const airFmt = (ts: number, tz?: string) =>
    new Date(ts * 1000).toLocaleString([], {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      ...(tz ? { timeZone: tz } : {}),
    })
  // the same date inside a chip, which shares its line with the episode number:
  // the locale separators are what pushes it past the phone column, and a chip
  // has no prose to hold together without them
  const airFmtChip = (ts: number) => airFmt(ts).replace(/,/g, '')
  // the backend owns the schedule (interval, smart sync, 12h stale re-check),
  // so this only formats what it sends
  const untilCheck = (ts: number) => (ts * 1000 <= now ? t('watch.checkDue') : countdown(t, ts, false, now))
  const isToday = (ts: number) => new Date(ts * 1000).toDateString() === new Date().toDateString()
  // the dashboard links straight into the calendar; the rest of the time the
  // page opens the way it was left
  const [view, setView] = usePersistedView('weebsync.watches.view', ['list', 'calendar'] as const, 'list')
  // list or grid, an inline switch like the calendar's week or list
  const [layout, setLayout] = usePersistedView('weebsync.watches.layout', ['list', 'grid'] as const, 'list', 'layout')
  // the calendar as a week, or as the plain list by day it used to be
  const [calMode, setCalMode] = usePersistedView('weebsync.watches.calendar', ['week', 'agenda'] as const, 'week', 'cal')
  const [calCat, setCalCat] = useState<'all' | CalCategory>('all')
  // a tap on a calendar entry opens the title's card
  // the cover and a calendar entry open the app's one title card
  const { open: openSeries } = useSeriesModal()
  const showSeries = (w: Watch, tab?: 'sync') => w.media && openSeries({ source: w.mediaSource, id: w.media.id, media: w.media, watchId: w.id, title: w.titleOverride || undefined, tab })
  // the gap list is the card's auto-sync tab; a watch without a record has no card
  const showGaps = (w: Watch) => showSeries(w, 'sync')
  // everything but "check now", for the desktop menu and the phone sheet alike
  const rowActions = (w: Watch): RowAction[] => [
    { key: 'edit', icon: <Pencil aria-hidden size="1em" />, label: t('servers.edit'), onClick: () => setEdit(w) },
    ...(w.plexAudioLang || w.plexSubLang
      ? [{ key: 'plex', icon: <Languages aria-hidden size="1em" />, label: t('watch.plexApplyAll'), onClick: () => void applyPlexStreams(w.id) }]
      : []),
    ...((w.missing?.length ?? 0) > 0 && w.media
      ? [{ key: 'gaps', icon: <TriangleAlert aria-hidden size="1em" />, label: t('watch.gapsAction'), onClick: () => showGaps(w) }]
      : []),
    { key: 'delete', icon: <Trash2 aria-hidden size="1em" />, label: t('servers.delete'), onClick: () => void del(w), danger: true },
  ]
  // the clock behind every countdown: a second while today's calendar
  // entries show seconds, a minute otherwise, so no countdown waits for a reload
  const hasToday = watches.some((w) => (w.airings ?? []).some((a) => isToday(a.at) && a.at * 1000 > Date.now()))
  const now = useNow(view === 'calendar' && hasToday ? 1000 : 60_000)
  // calendar: every release the backend knows about - the week it recorded
  // behind us and everything the providers have dated ahead
  const calEvents = upcomingAirings(watches, now)
  const calCats = CAL_CATEGORIES.filter((c) => calEvents.some((e) => e.watch.category === c))
  const calShown = calCat === 'all' ? calEvents : calEvents.filter((e) => e.watch.category === calCat)
  const firstDay = localeFirstDay()
  const today = startOfDay(new Date(now))
  const thisWeek = startOfWeek(today, firstDay)
  // The calendar counts in days from now: day 0 is today, and the band, the
  // panel and the desktop grid all read from that one number. An index is what
  // a deck pages and what the band snaps to, and it keeps a neighbouring day or
  // week a pure function of a number.
  const [dayIdx, setDayIdx] = useState(0)
  const selectedDate = addDays(today, dayIdx)
  const selectedDay = dayKey(selectedDate)
  const weekIdx = Math.round((startOfWeek(selectedDate, firstDay).getTime() - thisWeek.getTime()) / (7 * 86_400_000))
  // every release by day, for any day the band or a deck asks about
  const byDay = new Map<string, Airing[]>()
  for (const e of calShown) {
    const k = dayKey(new Date(e.at * 1000))
    byDay.set(k, [...(byDay.get(k) ?? []), e])
  }
  const weekDays = (i: number) => Array.from({ length: 7 }, (_, d) => addDays(thisWeek, i * 7 + d))
  const weekHasAny = (i: number) => weekDays(i).some((d) => byDay.has(dayKey(d)))
  // the first release after the shown day, for the jump out of a quiet stretch
  const nextAfter = calShown.find((e) => e.at * 1000 >= addDays(selectedDate, 1).getTime())
  const wide = useMediaQuery(WIDE_MQ)
  // How far the band reaches: to the last release the providers date, four
  // weeks at the least so there is always something to scrub through, and a
  // year at the most. A week of the past leads in - without it the band opens
  // against its own left edge with nothing beside today.
  const PAST_DAYS = 7
  const lastAt = calShown.length ? calShown[calShown.length - 1].at * 1000 : 0
  const span = Math.min(400, Math.max(28, Math.ceil((lastAt - today.getTime()) / 86_400_000) + 7))
  const bandDays = Array.from({ length: span + 1 + PAST_DAYS }, (_, i) => addDays(today, i - PAST_DAYS))
  const dayIdxOf = (d: Date) => Math.round((startOfDay(d).getTime() - today.getTime()) / 86_400_000)
  // how long a folded-away stretch really was, in the roughest unit that still
  // says something: a quiet day reads "14 Std.", not "840 Min."
  const gapLabel = (minutes: number) =>
    minutes >= 60 ? t('watch.week.gapHours', { h: Math.round(minutes / 60) }) : t('watch.week.gapMinutes', { m: Math.round(minutes) })
  // a week step lands on its first release, else on the week's first day still ahead
  const goWeek = (i: number) => {
    const start = addDays(thisWeek, i * 7)
    const end = addDays(start, 7)
    const first = calShown.find((e) => e.at * 1000 >= start.getTime() && e.at * 1000 < end.getTime())
    setDayIdx(Math.max(-PAST_DAYS, dayIdxOf(first ? new Date(first.at * 1000) : start)))
  }
  // the agenda: every release still ahead, grouped by day, as far as the
  // providers date them - the week behind belongs to the calendar, not here
  const calDayKey = (ts: number) => new Date(ts * 1000).toLocaleDateString([], { weekday: 'long', day: '2-digit', month: '2-digit' })
  const calGroups: { day: string; items: Airing[] }[] = []
  for (const e of calShown) {
    if (e.at * 1000 <= now) continue // an agenda of what is coming, not a log
    const day = calDayKey(e.at)
    const g = calGroups.find((x) => x.day === day)
    if (g) g.items.push(e)
    else calGroups.push({ day, items: [e] })
  }
  // one release, in the agenda, the phone's day or a desktop week column
  const entryOf = (e: Airing, compact?: boolean) => <li key={entryKey(e)}>{entryBody(e, compact)}</li>
  const entryKey = (e: Airing) => `${e.watch.id}-${e.episode}-${e.at}`
  const entryBody = (e: Airing, compact?: boolean) => {
    const name = e.watch.titleOverride || mediaTitle(e.watch.media, e.watch.remotePath.split('/').pop() || '')
    return (
      <>
        <CalendarEntry
          compact={compact}
          cover={e.watch.media?.coverImage?.large}
          title={name}
          episode={
            <>
              {t('watch.nextEp', { n: e.episode })}
              {e.episodeAbs && e.episodeAbs !== e.episode ? ` (${e.episodeAbs})` : ''}
            </>
          }
          time={
            // the JST hover lives on the text itself - CalendarEntry owns the <p> around it
            <span title={e.watch.mediaSource?.startsWith('tmdb') ? undefined : `${airFmt(e.at, 'Asia/Tokyo')} JST`}>
              {new Date(e.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(isToday(e.at) ? { second: '2-digit' } : {}) })}
            </span>
          }
          countdown={countdown(t, e.at, isToday(e.at), now)}
          onClick={e.watch.media ? () => showSeries(e.watch) : undefined}
          aria-label={e.watch.media ? t('remote.detailsFor', { name }) : undefined}
        />
      </>
    )
  }

  const [sort, setSort] = useState<'next' | 'last' | 'name' | 'season'>('next')
  // outside-click + Escape come from the design system's menu hook
  const { open: sortOpen, setOpen: setSortOpen, ref: sortRef, anchor: sortAnchor, anchorStyle: sortAnchorStyle } = useMenu()
  const SORT_OPTS = [
    { v: 'next', k: 'watch.sortNext' },
    { v: 'last', k: 'watch.sortLast' },
    { v: 'name', k: 'watch.sortName' },
    { v: 'season', k: 'watch.sortSeason' },
  ] as const
  const nextTs = (w: Watch) => (w.nextAiringAt ? w.nextAiringAt * 1000 : w.nextCheck * 1000)
  const nameOf = (w: Watch) => (w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || '')).toLowerCase()
  const seasonOf = (w: Watch) => Number(w.template.match(/S(\d+)E/i)?.[1] ?? 0)
  const sorted = [...watches].sort((a, b) => {
    switch (sort) {
      case 'last':
        return (Date.parse(b.lastCheck.replace(' ', 'T') + 'Z') || 0) - (Date.parse(a.lastCheck.replace(' ', 'T') + 'Z') || 0)
      case 'name':
        return nameOf(a).localeCompare(nameOf(b))
      case 'season':
        return seasonOf(a) - seasonOf(b) || nameOf(a).localeCompare(nameOf(b))
      default:
        return nextTs(a) - nextTs(b)
    }
  })
  // group by status: actively downloading on top, waiting in the middle,
  // finished at the bottom (each keeps the chosen sort order within it)
  const groupOf = (w: Watch): 'syncing' | 'waiting' | 'idle' | 'complete' =>
    w.active > 0 ? 'syncing' : w.complete ? 'complete' : w.waiting ? 'waiting' : 'idle'
  const GROUP_ORDER = ['syncing', 'idle', 'waiting', 'complete'] as const
  const grouped = GROUP_ORDER.map((g) => ({ g, items: sorted.filter((w) => groupOf(w) === g) })).filter((x) => x.items.length > 0)

  return (
    <div>
      {/* title + view toggle form a stable top bar: the toggle lives here in
          every view, so switching list/calendar never moves it. The
          view-specific controls (calendar filter / list sort) sit on their own
          row below and only they change - critical on a narrow phone viewport. */}
      <header className="mb-4 hidden flex-wrap items-end justify-between gap-3 lg:flex">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('watch.title')}</h2>
          <Badge className="mt-1">{t('watch.sub')}</Badge>
        </div>
      </header>
      {/* the view toggle and the sort menu are the page's secondary controls:
          in the app bar on a phone, in a row under the header on desktop.
          The row is right-aligned and the sort menu is the list's alone, so
          it leads: the toggle keeps its place when the menu goes away. */}
      <PageActions>
        <div className="flex items-center gap-2 lg:mb-4 lg:justify-end">
          {view !== 'calendar' && watches.length > 1 && (
            <div className="relative" ref={sortRef} style={sortAnchorStyle}>
              <Button
                size="sm"
                aria-haspopup="listbox"
                aria-expanded={sortOpen}
                aria-label={t('watch.sortBy')}
                title={t('watch.sortBy')}
                onClick={() => setSortOpen((o) => !o)}
              >
                <ArrowUpDown aria-hidden size="1.2em" />
              </Button>
              {sortOpen && (
                <Menu anchor={sortAnchor} placement="bottom-end" aria-label={t('watch.sortBy')}>
                  {SORT_OPTS.map((o) => (
                    <MenuItem
                      key={o.v}
                      selected={sort === o.v}
                      trailing={<Check aria-hidden size="1.2em" className="shrink-0" />}
                      onClick={() => {
                        setSort(o.v)
                        setSortOpen(false)
                      }}
                    >
                      {t(o.k)}
                    </MenuItem>
                  ))}
                </Menu>
              )}
            </div>
          )}
          <Segmented
            aria-label={t('watch.view')}
            value={view}
            onChange={setView}
            options={[
              {
                value: 'list',
                'aria-label': t('watch.viewWatches'),
                label: (
                  <>
                    <Tv aria-hidden size="1em" />
                    <span className="ml-1 hidden lg:inline">{t('watch.viewWatches')}</span>
                  </>
                ),
              },
              {
                value: 'calendar',
                'aria-label': t('watch.viewCalendar'),
                label: (
                  <>
                    <CalendarDays aria-hidden size="1em" />
                    <span className="ml-1 hidden lg:inline">{t('watch.viewCalendar')}</span>
                  </>
                ),
              },
            ]}
          />
        </div>
      </PageActions>

      {/* the same row as the calendar's week or list switch, so the two
          views read alike: what is shown up top, how it is laid out here */}
      {view === 'list' && watches.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          <Segmented
            aria-label={t('watch.layout')}
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'list', 'aria-label': t('watch.viewList'), label: <><List aria-hidden size="1em" /><span className="ml-1 hidden sm:inline">{t('watch.viewList')}</span></> },
              { value: 'grid', 'aria-label': t('watch.viewGrid'), label: <><LayoutGrid aria-hidden size="1em" /><span className="ml-1 hidden sm:inline">{t('watch.viewGrid')}</span></> },
            ]}
          />
        </div>
      )}
      {view === 'calendar' && calShown.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          {calCats.length > 1 && (
            <div role="group" aria-label={t('watch.calFilter')} className="mr-auto flex flex-wrap gap-1.5">
              <Badge as="button" type="button" tone={calCat === 'all' ? 'accent' : 'neutral'} aria-pressed={calCat === 'all'} onClick={() => setCalCat('all')}>
                {t('watch.calAll')}
              </Badge>
              {calCats.map((c) => (
                <Badge key={c} as="button" type="button" tone={calCat === c ? 'accent' : 'neutral'} aria-pressed={calCat === c} onClick={() => setCalCat(c)}>
                  {t(`watch.cat.${c}`)}
                </Badge>
              ))}
            </div>
          )}
          <Segmented
            aria-label={t('watch.calMode')}
            value={calMode}
            onChange={setCalMode}
            options={[
              { value: 'week', 'aria-label': t('watch.calWeek'), label: <><CalendarRange aria-hidden size="1em" /><span className="ml-1 hidden sm:inline">{t('watch.calWeek')}</span></> },
              { value: 'agenda', 'aria-label': t('watch.calAgenda'), label: <><List aria-hidden size="1em" /><span className="ml-1 hidden sm:inline">{t('watch.calAgenda')}</span></> },
            ]}
          />
        </div>
      ) : null}

      {error && (
        <p className="mb-3 rounded-md border border-err/40 px-3 py-2 text-sm text-err" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <Badge tone="accent" className="mb-3" role="status">
          {notice}
        </Badge>
      )}

      {isLoading ? (
        <SkeletonCards />
      ) : watches.length === 0 ? (
        <EmptyState>
          <Trans i18nKey="watch.empty">
            In der <Link to="/files" className="text-accent underline">Remote</Link>-Ansicht einen Ordner auswählen und „Beobachten" klicken.
          </Trans>
        </EmptyState>
      ) : view === 'calendar' ? (
        <div className="flex flex-col gap-4">
          {calShown.length === 0 ? (
            <EmptyState>{t('watch.calEmpty')}</EmptyState>
          ) : calMode === 'agenda' ? (
            <div className="flex flex-col gap-5">
              {calGroups.map((g) => (
                <CalendarDay key={g.day} day={g.day}>
                  {g.items.map((e) => entryOf(e))}
                </CalendarDay>
              ))}
            </div>
          ) : (
            <>
              {/* the band scrubs through the days; the row above it holds
                  still - the arrows jump a whole week, the button between them
                  returns to today, and the caption rolls when the day changes */}
              <DayScroller
                days={bandDays.map((d) => ({
                  key: dayKey(d),
                  weekday: d.toLocaleDateString([], { weekday: 'short' }),
                  day: d.getDate(),
                  count: byDay.get(dayKey(d))?.length,
                  today: d.getTime() === today.getTime(),
                  past: d.getTime() < today.getTime(),
                }))}
                selected={selectedDay}
                onSelect={(k) => setDayIdx(dayIdxOf(new Date(k + 'T00:00')))}
                step={dayIdx}
                label={selectedDate.toLocaleDateString([], { weekday: 'long', day: '2-digit', month: '2-digit' })}
                onPrev={dayIdx > -PAST_DAYS ? () => setDayIdx(Math.max(-PAST_DAYS, dayIdx - 7)) : undefined}
                onNext={() => setDayIdx(dayIdx + 7)}
                onToday={dayIdx !== 0 ? () => setDayIdx(0) : undefined}
                labels={{ prev: t('watch.week.prev'), next: t('watch.week.next'), today: t('watch.week.today'), strip: t('watch.week.strip') }}
              />
              {/* the phone shows one day and pages days, the desktop grid a
                  whole week and pages weeks - a day step would move nothing
                  visible there */}
              {!wide ? (
                <SwipeDeck index={dayIdx} onIndex={setDayIdx} canPrev={dayIdx > -PAST_DAYS} mouse>
                  {(i) => {
                    const d = addDays(today, i)
                    const items = byDay.get(dayKey(d)) ?? []
                    const heading = d.toLocaleDateString([], { weekday: 'long', day: '2-digit', month: '2-digit' })
                    if (items.length === 0) {
                      return (
                        <CalendarDay quietHeading day={heading}>
                          <li className="text-sm text-t-muted">
                            {t('watch.week.free')}
                            {i === dayIdx && nextAfter && (
                              <Button size="sm" className="ml-3" onClick={() => setDayIdx(dayIdxOf(new Date(nextAfter.at * 1000)))}>
                                {t('watch.week.jump')}
                              </Button>
                            )}
                          </li>
                        </CalendarDay>
                      )
                    }
                    // the day as a time axis: the wait between two releases is
                    // the height between them, cut short where it would be a
                    // screenful of nothing, and on today a marker that drifts
                    // down past them while the clock runs
                    return (
                      <section className="min-w-0">
                        <h3 className="sr-only">{heading}</h3>
                        <DayTimeline
                          entries={items.map((e) => ({ key: entryKey(e), at: e.at, node: entryBody(e) }))}
                          now={d.getTime() === today.getTime() ? now : undefined}
                          nowLabel={t('watch.week.now', { time: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
                          gapLabel={gapLabel}
                        />
                      </section>
                    )
                  }}
                </SwipeDeck>
              ) : (
                <SwipeDeck index={weekIdx} onIndex={goWeek} canPrev={weekIdx > 0} mouse>
                  {(i) =>
                    !weekHasAny(i) ? (
                      <EmptyState>
                        <p>{t('watch.week.empty')}</p>
                        {i === weekIdx && nextAfter && (
                          <Button size="sm" className="mt-3" onClick={() => setDayIdx(dayIdxOf(new Date(nextAfter.at * 1000)))}>
                            {t('watch.week.jump')}
                          </Button>
                        )}
                      </EmptyState>
                    ) : (
                      // desktop: the whole week side by side, today's column marked
                      <div className="grid grid-cols-7 gap-3">
                        {weekDays(i).map((d) => {
                          const k = dayKey(d)
                          const items = byDay.get(k) ?? []
                          return (
                            <CalendarDay
                              key={k}
                              className={k === dayKey(today) ? 'rounded-md outline-2 outline-offset-4 outline-accent/40' : d.getTime() < today.getTime() ? 'opacity-60' : undefined}
                              day={d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: '2-digit' })}
                            >
                              {items.length === 0 ? <li className="text-xs text-t-faint">{t('watch.week.free')}</li> : items.map((e) => entryOf(e, true))}
                            </CalendarDay>
                          )
                        })}
                      </div>
                    )
                  }
                </SwipeDeck>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="grid gap-6">
          {grouped.map(({ g, items }) => {
            const GroupIcon = GROUP_ICON[g]
            return (
            <section key={g}>
              <Divider
                className="mb-3"
                label={
                  <>
                    <GroupIcon aria-hidden size="1em" />
                    {t(`watch.group.${g}`)}
                  </>
                }
                count={items.length}
              />
              {layout === 'grid' ? (
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
                  {items.map((w) => (
                    <li key={w.id} className="min-w-0">
                      <WatchTile watch={w} onOpen={() => showSeries(w)} />
                    </li>
                  ))}
                </ul>
              ) : (
              <ul className="grid grid-cols-1 gap-3">
                {items.map((w) => (
                  <li key={w.id}>
                    <MediaCard
                      cover={w.media?.coverImage?.large}
                      onCover={w.media ? () => showSeries(w) : undefined}
                      coverLabel={
                        w.media ? t('remote.detailsFor', { name: w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || '') }) : undefined
                      }
                      title={w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || '')}
                      pathTitle={w.remotePath}
                      path={
                        <>
                          {w.serverName}:{w.remotePath} → {w.localPath}
                        </>
                      }
                      // the error text stays plain text rather than a chip
                      // title: it is the one status that has to be readable in
                      // full, and it can be a whole sentence long. Under it the
                      // schedule and the counters as one caption: they are the
                      // same on every watch, and a row of identical chips said
                      // nothing a line of text does not
                      meta={
                        <>
                          {w.lastResult && <span className="block text-err">{w.lastResult}</span>}
                          <span className="block">
                            {[
                              t('watch.chipLast', { when: ago(w.lastCheck) }) + (!w.lastResult && w.lastQueued >= 0 ? ` (${t('watch.lastQueued', { count: w.lastQueued })})` : ''),
                              w.checkAttempts
                                ? t('watch.chipRetry', { n: w.checkAttempts, when: untilCheck(w.nextCheck) })
                                : t('watch.chipNext', { when: untilCheck(w.nextCheck) }),
                              (w.seenEpisodes ?? 0) > 0 ? t('watch.seen', { count: w.seenEpisodes }) : null,
                              w.template || w.pattern ? t('watch.renamed') : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </>
                      }
                      badges={
                        <>
                          {/* the upcoming episode leads the row: it is what the
                              page is watched for. Number and date share one chip
                              so they cannot end up on separate lines. */}
                          {!!w.nextAiringAt && (
                            <Badge
                              tone={w.behind ? 'warn' : 'ok'}
                              size="sm"
                              title={w.mediaSource?.startsWith('tmdb') ? undefined : `${airFmt(w.nextAiringAt, 'Asia/Tokyo')} JST`}
                            >
                              <CalendarDays aria-hidden size="1em" />
                              {t('watch.chipEp', { n: w.nextEpisode })}
                              {w.nextEpisodeAbs && w.nextEpisodeAbs !== w.nextEpisode ? ` (${w.nextEpisodeAbs})` : ''}
                              {` · ${airFmtChip(w.nextAiringAt)}`}
                            </Badge>
                          )}
                          {(w.behind ?? 0) > 0 && (
                            <Badge tone="warn" size="sm">
                              <Clock aria-hidden size="1em" />
                              {t('watch.behind', { count: w.behind })}
                            </Badge>
                          )}
                          {(w.missing?.length ?? 0) > 0 && (
                            // the episode list is this badge's own detail view,
                            // so the chip is the button that opens it - a span
                            // with onClick would be unreachable by keyboard
                            <Badge
                              as="button"
                              type="button"
                              tone="err"
                              size="sm"
                              title={w.missing!.join(', ')}
                              onClick={() => showGaps(w)}
                            >
                              <TriangleAlert aria-hidden size="1em" />
                              {t('watch.missing', { count: w.missing!.length, eps: fmtMissing(w.missing!, w.offset) })}
                            </Badge>
                          )}
                          {(w.unsorted ?? 0) > 0 && (
                            // not an error: the file is here, only its place is
                            // still open until the provider lists the number
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
                            // the one setting that used to fail in total silence:
                            // a language the files do not carry left Plex on its
                            // own default and said nothing
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
                        </>
                      }
                      status={
                        <>
                          {w.media && w.media.episodes > 0 ? (
                            <p className={w.complete ? 'text-ok' : 'text-t-secondary'}>
                              {t('watch.episodes', { have: w.localFiles, total: w.media.episodes })}
                            </p>
                          ) : (
                            <p className="text-t-secondary">{t('watch.files', { count: w.localFiles })}</p>
                          )}
                          {w.complete && (
                            <p className="mt-1 text-ok" role="status">
                              <Check aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                              {t('watch.complete')}
                            </p>
                          )}
                        </>
                      }
                      actions={
                        <>
                          <Button size="sm" className="flex-1 sm:flex-none" onClick={() => check(w.id)}>
                            <RefreshCw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                            {t('watch.checkNow')}
                          </Button>
                          {narrow ? (
                            <IconButton
                              aria-label={t('watch.moreActions', { title: nameOf(w) })}
                              aria-haspopup="dialog"
                              className="min-w-0! border border-border-subtle"
                              onClick={() => setMore(w)}
                            >
                              <Ellipsis aria-hidden size="1.2em" />
                            </IconButton>
                          ) : (
                            <RowMenu label={t('watch.moreActions', { title: nameOf(w) })} items={rowActions(w)} />
                          )}
                        </>
                      }
                    />
                  </li>
                ))}
              </ul>
              )}
            </section>
            )
          })}
        </div>
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
      {more && (
        <Dialog width="max-w-sm" onClose={() => setMore(null)} aria-labelledby="watch-more-title">
          <header className="border-b border-border-subtle px-5 py-4">
            <h3 id="watch-more-title" className="truncate font-display font-semibold tracking-wider">
              {more.titleOverride || mediaTitle(more.media, more.remotePath.split('/').pop() || '')}
            </h3>
          </header>
          <div className="flex flex-col gap-1 p-2">
            {rowActions(more).map((a) => (
              <Button
                key={a.key}
                variant={a.danger ? 'danger' : 'default'}
                className="justify-start gap-2"
                onClick={() => {
                  setMore(null)
                  a.onClick()
                }}
              >
                {a.icon}
                {a.label}
              </Button>
            ))}
          </div>
        </Dialog>
      )}
    </div>
  )
}

interface RowAction {
  key: string
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}

// The overflow of a watch row on desktop: the same entries the phone sheet
// lists, as an anchored menu next to the one button that stays visible.
function RowMenu({ label, items }: { label: string; items: RowAction[] }) {
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  return (
    <div className="relative" ref={ref} style={anchorStyle}>
      <IconButton aria-label={label} aria-haspopup="listbox" aria-expanded={open} className="border border-border-subtle" onClick={() => setOpen(!open)}>
        <Ellipsis aria-hidden size="1.2em" />
      </IconButton>
      {open && (
        <Menu anchor={anchor} placement="bottom-end" aria-label={label}>
          {items.map((a) => (
            <MenuItem
              key={a.key}
              onClick={() => {
                setOpen(false)
                a.onClick()
              }}
            >
              <span className={`flex items-center gap-2 ${a.danger ? 'text-err' : ''}`}>
                {a.icon}
                {a.label}
              </span>
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  )
}

// A watch as a poster tile: the poster is the button into the title card,
// where the actions are; the tile itself only says what the list's chips say
// - the next episode, how far the copy is, whether something needs a hand.
function WatchTile({ watch: w, onOpen }: { watch: Watch; onOpen: () => void }) {
  const { t } = useTranslation()
  const name = w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || '')
  const total = w.media?.episodes ?? 0
  const attention = (w.missing?.length ?? 0) > 0 || (w.langWaiting ?? 0) > 0 || w.lastResult !== ''
  // what the warning chip stands for, as its tooltip and for a screen reader
  const attentionText = [
    (w.missing?.length ?? 0) > 0 ? t('watch.missing', { count: w.missing!.length, eps: fmtMissing(w.missing!, w.offset) }) : null,
    (w.langWaiting ?? 0) > 0 ? t('watch.langWaiting', { count: w.langWaiting, lang: [w.wantDub && `${w.wantDub}-Dub`, w.wantSub && `${w.wantSub}-Sub`].filter(Boolean).join('/') }) : null,
    w.lastResult || null,
  ]
    .filter(Boolean)
    .join('. ')
  // day and month only: with the weekday the chip ran past a 140px tile
  const when = (ts: number) => new Date(ts * 1000).toLocaleDateString([], { day: '2-digit', month: '2-digit' })
  return (
    <Panel as="article" className="group relative flex flex-col overflow-clip transition-colors hover:border-accent/50!">
      {/* named by what it shows: a label of its own would hide the visible
          text from the accessible name (WCAG 2.5.3) */}
      <button
        type="button"
        className="text-left"
        onClick={onOpen}
        disabled={!w.media}
      >
        <Cover size="fill" src={w.media?.coverImage?.large} loading="lazy" className="opacity-90 transition-opacity group-hover:opacity-100">
          {!w.media && <span className="p-2 text-center text-xs text-t-muted">{name}</span>}
        </Cover>
        <div className="p-2">
          <h3 className="line-clamp-2 text-sm font-medium text-t-primary" title={name}>
            {name}
          </h3>
          {/* under the title, not over the poster: chips on a busy poster
              were barely there, whatever their surface */}
          {(!!w.nextAiringAt || w.active > 0 || attention) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {!!w.nextAiringAt && (
                <Badge size="sm" tone={w.behind ? 'warn' : 'ok'}>
                  {t('watch.chipEp', { n: w.nextEpisode })} · {when(w.nextAiringAt)}
                </Badge>
              )}
              {w.active > 0 && (
                <Badge size="sm" tone="accent">
                  <Download aria-hidden size="1em" />
                  {w.active}
                </Badge>
              )}
              {attention && (
                <Badge size="sm" tone="err" title={attentionText}>
                  <TriangleAlert aria-hidden size="1em" />
                  <span className="sr-only">{attentionText}</span>
                </Badge>
              )}
            </div>
          )}
          <p className={`mt-1 text-[11px] ${w.complete ? 'text-ok' : 'text-t-muted'}`}>
            {total > 0 ? t('watch.episodes', { have: w.localFiles, total }) : t('watch.files', { count: w.localFiles })}
          </p>
          {total > 0 && (
            <Progress
              value={(w.localFiles / total) * 100}
              size="sm"
              tone={w.complete ? 'ok' : 'accent'}
              active={w.active > 0}
              label={t('series.progressLabel', { name })}
              className="mt-1.5"
            />
          )}
        </div>
      </button>
    </Panel>
  )
}
