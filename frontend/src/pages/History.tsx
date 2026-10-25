import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Input, PageHeader, Segmented, useEnterPage } from 'fluid-lycoris'
import { api, downloadLabel, fmtBytes, type Download, type DownloadMeta, type Watch } from '../api'
import { useNow, usePersistedQuery } from '../hooks'
import { useUrlState } from '../hooks/useUrlState'
import { coverSet } from '../images'
import { CoverImg } from '../components/SmartImg'
import { useSeriesModal } from '../components/SeriesModal'
import {
  endedAt,
  filterHistory,
  groupByDay,
  histKind,
  langName,
  weekSummary,
  type HistFilter,
  type HistKind,
} from './today/history'
import { LoadError } from './today/LoadError'
import { seriesTarget } from './today/shared'
import './today/today.css'

const MARKS: Record<HistKind, string> = {
  done: 'M5 12.5l4.5 4.5L19 7.5',
  up: 'M12 19V5M6 11l6-6 6 6',
  fail: 'M7 7l10 10M17 7L7 17',
}

const FILTERS: HistFilter[] = ['all', 'done', 'up', 'fail']

/**
 * Verlauf: what landed when. The week in four numbers, a filter and a
 * search, and the finished downloads by day; a row opens to the file's facts
 * and leads to its series.
 */
export default function History() {
  const { t, i18n } = useTranslation()
  const now = useNow()
  const dlq = useQuery<Download[]>({
    queryKey: ['downloads'],
    queryFn: () => api.get('/api/downloads'),
    refetchInterval: 15_000,
  })
  const { data: downloads = [], isLoading } = dlq
  const failed = dlq.isError && dlq.data === undefined
  // the facts (duration, rate) of a download that just landed are in a fresh read
  const { data: meta } = useQuery<DownloadMeta>({
    queryKey: ['downloads', 'meta'],
    queryFn: () => api.get('/api/downloads/meta'),
    staleTime: 0,
  })
  const { data: watches = [] } = usePersistedQuery<Watch[]>('watches', () => api.get('/api/watches'))
  // the dashboard's "+N more" arrives here as ?filter=fail; the search is
  // ?q=. Both live in the address, a change replaces the entry.
  const [filterParam, setFilter] = useUrlState('filter', 'all')
  const filter: HistFilter = FILTERS.find((f) => f === filterParam) ?? 'all'
  const [query, setQuery] = useUrlState('q')
  const list = useRef<HTMLDivElement>(null)
  useEnterPage(list, `${filter}|${isLoading}`)
  const { open } = useSeriesModal()

  const titleOf = (d: Download) => {
    const { group, name } = downloadLabel(d, meta)
    return group?.title || name
  }
  const sum = weekSummary(downloads, now)
  const days = groupByDay(filterHistory(downloads, filter, query, titleOf), now)
  const hm = (ms: number) => new Date(ms).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
  const dayName = (day: number, ago: number) =>
    ago === 0
      ? t('history.today')
      : ago === 1
        ? t('history.yesterday')
        : new Date(day).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' })
  const langs = (codes?: string[]) => (codes?.length ? codes.map((c) => langName(c, i18n.language)).join(', ') : null)
  const duration = (secs: number) => t('history.took', { m: Math.floor(secs / 60), s: secs % 60 })
  const rate = (bps: number) =>
    `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(bps / 1024 / 1024)} MiB/s`

  return (
    <div className="flex flex-col">
      <PageHeader className="mb-4" title={t('history.title')} />
      <div className="hs-sum">
        <div>
          <b>{sum.episodes}</b>
          <span>{t('history.weekEpisodes')}</span>
        </div>
        <div>
          <b>{fmtBytes(sum.bytes)}</b>
          <span>{t('history.weekLoaded')}</span>
        </div>
        <div>
          <b>{sum.upgrades}</b>
          <span>{t('history.upgrades')}</span>
        </div>
        <div>
          <b>{sum.failed}</b>
          <span>{t('history.failed')}</span>
        </div>
      </div>
      <div className="hs-tools">
        <Segmented
          aria-label={t('history.filter')}
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({ value: f, label: t(`history.f.${f}`) }))}
        />
        <label className="hs-q">
          <span className="sr-only">{t('history.search')}</span>
          <Input
            kind="search"
            value={query}
            placeholder={t('history.searchHint')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div ref={list}>
        {isLoading &&
          [0, 1, 2, 3].map((i) => <div key={i} aria-hidden className="td-sk-row" style={{ height: '3.75rem' }} />)}
        <LoadError failed={!isLoading && failed} onRetry={async () => (await dlq.refetch()).isError} />
        {!isLoading && !failed && days.length === 0 && <p className="td-empty">{t('history.none')}</p>}
        {days.map((day) => (
          <section key={day.day} aria-labelledby={`hs-${day.day}`}>
            <h2 id={`hs-${day.day}`} className="hs-day">
              {dayName(day.day, day.ago)}
            </h2>
            <ul className="t-rows">
              {day.items.map((d) => {
                const kind = histKind(d)!
                const { group, item, name, ep } = downloadLabel(d, meta)
                const title = group?.title || name
                const watch = group?.watchId ? watches.find((w) => w.id === group.watchId) : undefined
                const reason =
                  kind === 'up' ? t('history.reasonUp') : kind === 'fail' ? d.error || t('today.needFailedSub') : ''
                const file = d.localPath.split('/').pop() || name
                const facts: [string, string | null, boolean?][] =
                  kind === 'fail'
                    ? [
                        [t('history.reason'), d.error || t('today.needFailedSub')],
                        [t('history.server'), group?.serverName || null],
                      ]
                    : [
                        [t('history.file'), file, true],
                        [t('history.size'), fmtBytes(d.size)],
                        [t('history.picture'), item?.res ? `${item.res}p` : null],
                        [t('history.audio'), langs(item?.dub)],
                        [t('history.subs'), langs(item?.sub)],
                        [t('history.source'), group?.serverName || null],
                        [
                          t('history.duration'),
                          item?.secs
                            ? [duration(item.secs), item.rate ? rate(item.rate) : null].filter(Boolean).join(', ')
                            : null,
                        ],
                      ]
                return (
                  <li key={d.id} className="t-row hs-row">
                    <details>
                      <summary className="t-row-in">
                        <time dateTime={new Date(endedAt(d)).toISOString()}>{hm(endedAt(d))}</time>
                        <CoverImg
                          set={coverSet({ large: group?.cover, extraLarge: group?.coverLarge })}
                          title={title}
                          sizes="32px"
                        />
                        <span className="t-row-t">
                          <strong>{title}</strong>
                          <span>{[ep, reason].filter(Boolean).join(' · ') || name}</span>
                        </span>
                        <span className="hs-sz">{kind === 'fail' ? '' : fmtBytes(d.size)}</span>
                        <span className="hs-mk" data-kind={kind} role="img" aria-label={t(`history.mark.${kind}`)}>
                          <svg viewBox="0 0 24 24" aria-hidden>
                            <path d={MARKS[kind]} />
                          </svg>
                        </span>
                      </summary>
                      <div className="hs-facts">
                        <dl>
                          {facts
                            .filter(([, v]) => v)
                            .map(([k, v, mono]) => (
                              <div key={k} className="contents">
                                <dt>{k}</dt>
                                <dd className={mono ? 'mono' : undefined}>{v}</dd>
                              </div>
                            ))}
                        </dl>
                        {watch?.media && (
                          <button type="button" className="t-link" onClick={() => open(seriesTarget(watch))}>
                            {t('dash.openSeries')}
                          </button>
                        )}
                      </div>
                    </details>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
