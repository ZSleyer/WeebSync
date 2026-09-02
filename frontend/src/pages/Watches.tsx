import { useEffect, useState } from 'react'
import {
  ArrowUpDown,
  CalendarDays,
  Check,
  Clock,
  Download,
  Eye,
  FolderClock,
  History,
  Languages,
  List,
  Pencil,
  PenLine,
  RefreshCw,
  Timer,
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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  Badge,
  Button,
  CalendarDay,
  CalendarEntry,
  Divider,
  EmptyState,
  MediaCard,
  Menu,
  MenuItem,
  useMenu,
} from '@weebsync/design-system'
import { api, fmtMissing, mediaTitle, type Watch } from '../api'
import { countdown } from '../countdown'
import WatchDialog from '../components/WatchDialog'
import WatchEpisodesModal from '../components/WatchEpisodesModal'
import { useConfirm } from '../components/confirm'
import { SkeletonCards } from '../components/Loading'

type CalCategory = 'anime-series' | 'anime-movie' | 'series' | 'movie'
const CAL_CATEGORIES: readonly CalCategory[] = ['anime-series', 'anime-movie', 'series', 'movie']
type CalEvent = { at: number; episode: number; episodeAbs?: number; watch: Watch }

// Watches: persistent auto-sync overview. Each watch re-checks its remote
// folder on an interval; the list polls so check results appear live.
export default function Watches() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: watches = [], isLoading } = useQuery<Watch[]>({
    queryKey: ['watches'],
    queryFn: () => api.get('/api/watches'),
    refetchInterval: 10_000,
  })
  const [edit, setEdit] = useState<Watch | null>(null)
  // the watch whose episode list is open; the modal fetches on mount
  const [gaps, setGaps] = useState<Watch | null>(null)
  const [error, setError] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['watches'] })

  const check = async (id: number) => {
    setError('')
    try {
      await api.post(`/api/watches/${id}/check`)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
      return
    }
    setTimeout(refresh, 1500)
  }
  const [notice, setNotice] = useState('')
  const applyPlexStreams = async (id: number) => {
    setError('')
    try {
      await api.post(`/api/watches/${id}/plex-streams`)
      setNotice(t('watch.plexApplyQueued'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    }
  }
  const del = async (w: Watch) => {
    if (!(await confirm({ message: t('watch.confirmDelete', { name: w.remotePath }), destructive: true }))) return
    setError('')
    try {
      await api.del(`/api/watches/${w.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
      return
    }
    refresh()
  }

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
  const untilCheck = (ts: number) => (ts * 1000 <= Date.now() ? t('watch.checkDue') : countdown(t, ts))
  const isToday = (ts: number) => new Date(ts * 1000).toDateString() === new Date().toDateString()
  // calendar: flatten every scheduled future release the provider knows into
  // per-day events - not just each watch's single next airing, so it reaches as
  // far ahead as AniList's airingSchedule / TMDB's season episodes are dated.
  const calDayKey = (ts: number) => new Date(ts * 1000).toLocaleDateString([], { weekday: 'long', day: '2-digit', month: '2-digit' })
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const [calCat, setCalCat] = useState<'all' | CalCategory>('all')
  // 1s tick so today's countdowns/clocks stay live (calendar view only)
  const [, setTick] = useState(0)
  const hasToday = watches.some((w) => (w.airings ?? []).some((a) => isToday(a.at) && a.at * 1000 > Date.now()))
  useEffect(() => {
    if (view !== 'calendar' || !hasToday) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [view, hasToday])
  const calEvents: CalEvent[] = watches
    .flatMap((w) => (w.airings ?? []).map((a) => ({ at: a.at, episode: a.episode, episodeAbs: a.episodeAbs, watch: w })))
    .filter((e) => e.at * 1000 > Date.now())
    .sort((a, b) => a.at - b.at)
  const calCats = CAL_CATEGORIES.filter((c) => calEvents.some((e) => e.watch.category === c))
  const calShown = calCat === 'all' ? calEvents : calEvents.filter((e) => e.watch.category === calCat)
  const calGroups: { day: string; items: CalEvent[] }[] = []
  for (const e of calShown) {
    const day = calDayKey(e.at)
    const g = calGroups.find((x) => x.day === day)
    if (g) g.items.push(e)
    else calGroups.push({ day, items: [e] })
  }

  const [sort, setSort] = useState<'next' | 'last' | 'name' | 'season'>('next')
  // outside-click + Escape come from the design system's menu hook
  const { open: sortOpen, setOpen: setSortOpen, ref: sortRef } = useMenu()
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
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('watch.title')}</h2>
          <Badge className="mt-1">{t('watch.sub')}</Badge>
        </div>
        <div role="group" aria-label={t('watch.view')} className="flex shrink-0">
          <Button
            size="sm"
            variant={view === 'list' ? 'primary' : 'default'}
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            <List aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('watch.viewList')}
          </Button>
          <Button
            size="sm"
            variant={view === 'calendar' ? 'primary' : 'default'}
            aria-pressed={view === 'calendar'}
            onClick={() => setView('calendar')}
          >
            <CalendarDays aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('watch.viewCalendar')}
          </Button>
        </div>
      </header>

      {(view === 'calendar' && calCats.length > 1) || (view === 'list' && watches.length > 1) ? (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          {view === 'calendar' && calCats.length > 1 && (
            <div role="group" aria-label={t('watch.calFilter')} className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={calCat === 'all' ? 'primary' : 'default'}
                aria-pressed={calCat === 'all'}
                onClick={() => setCalCat('all')}
              >
                {t('watch.calAll')}
              </Button>
              {calCats.map((c) => (
                <Button
                  key={c}
                  size="sm"
                  variant={calCat === c ? 'primary' : 'default'}
                  aria-pressed={calCat === c}
                  onClick={() => setCalCat(c)}
                >
                  {t(`watch.cat.${c}`)}
                </Button>
              ))}
            </div>
          )}
          {view === 'list' && watches.length > 1 && (
            <div className="relative" ref={sortRef}>
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
                <Menu className="absolute right-0 z-20 mt-1" aria-label={t('watch.sortBy')}>
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
        </div>
      ) : null}

      {error && (
        <p className="mb-3 border border-err/40 px-3 py-2 text-sm text-err" role="alert">
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
            In der <Link to="/remote" className="text-accent underline">Remote</Link>-Ansicht einen Ordner auswählen und „Beobachten" klicken.
          </Trans>
        </EmptyState>
      ) : view === 'calendar' ? (
        <div className="flex flex-col gap-5">
          {calGroups.length === 0 ? (
            <EmptyState>{t('watch.calEmpty')}</EmptyState>
          ) : (
            calGroups.map((g) => (
              <CalendarDay key={g.day} day={g.day}>
                {g.items.map((e) => (
                  <li key={`${e.watch.id}-${e.episode}-${e.at}`}>
                    <CalendarEntry
                      cover={e.watch.media?.coverImage?.large}
                      title={e.watch.titleOverride || mediaTitle(e.watch.media, e.watch.remotePath.split('/').pop() || '')}
                      episode={
                        <>
                          {t('watch.nextEp', { n: e.episode })}
                          {e.episodeAbs && e.episodeAbs !== e.episode ? ` (${e.episodeAbs})` : ''}
                        </>
                      }
                      time={
                        // the JST hover lives on the text itself - CalendarEntry
                        // owns the <p> around it
                        <span title={e.watch.mediaSource?.startsWith('tmdb') ? undefined : `${airFmt(e.at, 'Asia/Tokyo')} JST`}>
                          {new Date(e.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(isToday(e.at) ? { second: '2-digit' } : {}) })}
                        </span>
                      }
                      countdown={countdown(t, e.at, isToday(e.at))}
                    />
                  </li>
                ))}
              </CalendarDay>
            ))
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
              <ul className="grid grid-cols-1 gap-3">
                {items.map((w) => (
                  <li key={w.id}>
                    <MediaCard
                      cover={w.media?.coverImage?.large}
                      title={w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || '')}
                      pathTitle={w.remotePath}
                      path={
                        <>
                          {w.serverName}:{w.remotePath} → {w.localPath}
                        </>
                      }
                      // the error text stays plain text rather than a chip
                      // title: it is the one status that has to be readable in
                      // full, and it can be a whole sentence long
                      meta={w.lastResult ? <span className="text-err">{w.lastResult}</span> : undefined}
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
                              onClick={() => setGaps(w)}
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
                          {(w.seenEpisodes ?? 0) > 0 && (
                            <Badge size="sm">
                              <Eye aria-hidden size="1em" />
                              {t('watch.seen', { count: w.seenEpisodes })}
                            </Badge>
                          )}
                          {(w.template || w.pattern) && (
                            <Badge size="sm">
                              <PenLine aria-hidden size="1em" />
                              {t('watch.renamed')}
                            </Badge>
                          )}
                          {/* the schedule closes the row: the same two chips on
                              every watch, so the tail reads the same everywhere */}
                          <Badge size="sm" tone={w.lastResult ? 'err' : undefined}>
                            <History aria-hidden size="1em" />
                            {t('watch.chipLast', { when: ago(w.lastCheck) })}
                            {!w.lastResult && w.lastQueued >= 0 && ` · ${t('watch.lastQueued', { count: w.lastQueued })}`}
                          </Badge>
                          {/* a failed check is on a short backoff, not the
                              interval: say which attempt is coming, or the
                              next-check chip reads like nothing went wrong */}
                          <Badge size="sm" tone={w.checkAttempts ? 'warn' : undefined}>
                            <Timer aria-hidden size="1em" />
                            {w.checkAttempts
                              ? t('watch.chipRetry', { n: w.checkAttempts, when: untilCheck(w.nextCheck) })
                              : t('watch.chipNext', { when: untilCheck(w.nextCheck) })}
                          </Badge>
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
                          <Button size="sm" className="flex-1 sm:flex-initial" onClick={() => check(w.id)}>
                            <RefreshCw aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                            {t('watch.checkNow')}
                          </Button>
                          {(w.plexAudioLang || w.plexSubLang) && (
                            <Button
                              size="sm"
                              className="flex-1 sm:flex-initial"
                              title={t('watch.plexApplyAllHint')}
                              onClick={() => applyPlexStreams(w.id)}
                            >
                              {t('watch.plexApplyAll')}
                            </Button>
                          )}
                          <Button size="sm" className="flex-1 sm:flex-initial" onClick={() => setEdit(w)}>
                            <Pencil aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                            {t('servers.edit')}
                          </Button>
                          <Button size="sm" variant="danger" className="flex-1 sm:flex-initial" onClick={() => del(w)}>
                            <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                            {t('servers.delete')}
                          </Button>
                        </>
                      }
                    />
                  </li>
                ))}
              </ul>
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
          initial={{
            remotePath: edit.remotePath,
            localPath: edit.localPath,
            mode: edit.mode || 'template',
            template: edit.template,
            separator: edit.separator,
            titleOverride: edit.titleOverride,
            pattern: edit.pattern,
            replacement: edit.replacement,
            subfolder: edit.subfolder,
            mediaId: edit.mediaId,
            mediaSource: edit.mediaSource || 'anilist',
            fromEpisode: edit.fromEpisode,
            airedMapping: edit.airedMapping ?? false,
            renameProvider: edit.renameProvider ?? '',
            renameOrdering: edit.renameOrdering ?? '',
            renameTitleLang: edit.renameTitleLang ?? '',
            renameSeriesId: edit.renameSeriesId ?? 0,
            wantDub: edit.wantDub ?? '',
            wantSub: edit.wantSub ?? '',
            plexAudioLang: edit.plexAudioLang ?? '',
            plexSubLang: edit.plexSubLang ?? '',
          }}
          onSave={async (f) => {
            await api.put(`/api/watches/${edit.id}`, f)
            refresh()
          }}
          onClose={() => setEdit(null)}
        />
      )}
      {gaps && <WatchEpisodesModal watch={gaps} onClose={() => setGaps(null)} />}
    </div>
  )
}
