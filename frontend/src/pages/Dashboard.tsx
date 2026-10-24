import { useRef, type CSSProperties, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Progress, SectionHeading } from 'fluid-lycoris'
import {
  api,
  downloadLabel,
  fmtBytes,
  type Download,
  type DownloadMeta,
  type JobsStatus,
  type SystemStatus,
} from '../api'
import { upcomingAirings } from '../airings'
import { jobLabel } from '../jobs'
import { useTransfers } from '../components/transfers'
import { useAuth } from '../hooks'
import { LoadError } from './today/LoadError'
import { Agenda } from './today/Agenda'
import { HeroBanner } from './today/HeroBanner'
import { buildNeeds, hiddenNeeds } from './today/needs'
import { Needs } from './today/Needs'
import { useNeedsData } from './today/useNeedsData'
import { NewShelf } from './today/NewShelf'
import { useAfterFirstPaint, useFold, useRiseOnData } from './today/shared'
import './today/today.css'

/**
 * Heute: the page the app opens on. A manga page of the user's series with
 * the date and what is going on, what landed this week, what needs a hand,
 * what transfers right now (a phone also has the live pill), what airs
 * next and how full the disks are. Managing the queue lives in the
 * transfers sheet or panel.
 */
export default function Dashboard() {
  const { t, i18n } = useTranslation()
  const { now, downloads, isLoading, meta, watches, watchesLoading, detected, plexToken, mediaChoose, failed, retry } =
    useNeedsData()

  const work = useWorkNote()
  // the caption's line: what loads, what needs a hand, when the next one
  // airs, and which background job runs or waits
  const loadingCount = downloads.filter((d) => d.status === 'running' || d.status === 'queued').length
  const hidden = hiddenNeeds()
  const needCount = buildNeeds(t, { downloads, meta, watches, detected, now, plexToken, mediaChoose }).filter(
    (n) => !hidden.has(n.print),
  ).length
  const next = upcomingAirings(watches, now, 7).find((a) => a.at * 1000 > now)
  const nextAt = next
    ? new Date(next.at * 1000).toLocaleString(i18n.language, {
        ...(new Date(next.at * 1000).toDateString() === new Date(now).toDateString() ? {} : { weekday: 'short' }),
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''
  const status = [
    loadingCount > 0 ? t('today.loadingCount', { count: loadingCount }) : failed ? null : t('today.quiet'),
    needCount > 0 ? t('today.needCount', { count: needCount }) : null,
    nextAt ? t('today.nextAt', { time: nextAt }) : null,
    work,
  ].filter(Boolean)
  const date = new Date(now).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' })
  const loading = isLoading || watchesLoading
  // the hero and the shelf first; the rest a frame later (useAfterFirstPaint)
  const late = useAfterFirstPaint()

  return (
    <div className="td-view">
      <HeroBanner date={date} status={status} statusLoading={loading} />
      <div className="td-cols">
        <div className="td-main">
          <NewShelf downloads={downloads} meta={meta} watches={watches} loading={isLoading} />
          {late && (
            <Needs
              downloads={downloads}
              meta={meta}
              watches={watches}
              detected={detected}
              plexToken={plexToken}
              mediaChoose={mediaChoose}
              loading={loading}
              failed={failed}
              onRetry={retry}
            />
          )}
          {late && <Transfers downloads={downloads} meta={meta} loading={isLoading} failed={failed} onRetry={retry} />}
        </div>
        <div className="td-aside">
          {late && (
            <>
              <Agenda watches={watches} loading={watchesLoading} />
              <Storage />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * "Übertragung": what runs right now, a row each with the wave;
 * the rest of the queue is in the transfers panel behind "Details".
 */
function Transfers({
  downloads,
  meta,
  loading,
  failed,
  onRetry,
}: {
  downloads: Download[]
  meta?: DownloadMeta
  loading: boolean
  failed: boolean
  onRetry: () => void
}) {
  const { t, i18n } = useTranslation()
  const transfers = useTransfers()
  const body = useRef<HTMLDivElement>(null)
  useRiseOnData(body, !loading)
  const fold = useFold('transfers')
  const running = downloads.filter((d) => d.status === 'running')
  const pct = (d: Download) => (d.size > 0 ? Math.min(100, (d.transferred / d.size) * 100) : 0)
  return (
    <section aria-labelledby="td-dl-h">
      <SectionHeading
        id="td-dl-h"
        title={t('dash.transferSection')}
        action={
          <button type="button" className="t-link" aria-haspopup="dialog" onClick={() => transfers.open()}>
            {t('today.details')}
          </button>
        }
        fold={fold}
      />
      <div ref={body} id={fold.controls} hidden={!fold.open}>
        <ul className="t-rows td-dl">
          {loading && <li aria-hidden className="td-sk-row" />}
          {!loading && running.length === 0 && failed && <LoadError inline onRetry={onRetry} />}
          {!loading && running.length === 0 && !failed && (
            <li className="td-empty">
              <Trans i18nKey="dash.idle" components={{ go: <Link to="/files" className="t-link" /> }} />
            </li>
          )}
          {running.map((d) => {
            const { group, label, ep } = downloadLabel(d, meta)
            const title = group?.title || label
            const p = pct(d)
            return (
              <li key={d.id} className="t-row">
                <div className="t-row-in">
                  <div className="t-row-t">
                    <strong>{title}</strong>
                    <span>
                      {[ep, t('today.ofSize', { done: fmtBytes(d.transferred), total: fmtBytes(d.size) })]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  <span className="td-eta">
                    {new Intl.NumberFormat(i18n.language, { style: 'percent' }).format(p / 100)}
                  </span>
                  <Progress value={p} wave active label={t('dash.progressOf', { name: title })} />
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

/**
 * "Speicher": per disk the path, how much of it is used, and a meter that
 * fills once (warning colours from 85 % and 95 %); only for an admin, who
 * can act on it.
 */
function Storage() {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const { data } = useQuery<SystemStatus>({
    queryKey: ['status'],
    queryFn: () => api.get('/api/status'),
    refetchInterval: 60_000,
    enabled: !!user?.isAdmin,
  })
  const body = useRef<HTMLDivElement>(null)
  const fold = useFold('storage')
  const disks = (data?.disks ?? (data?.disk ? [data.disk] : [])).filter((d) => d.totalBytes > 0)
  useRiseOnData(body, disks.length > 0)
  if (!user?.isAdmin || (data && disks.length === 0)) return null
  return (
    <section aria-labelledby="td-disk-h">
      <SectionHeading id="td-disk-h" title={t('dash.storage')} fold={fold} />
      <div ref={body} id={fold.controls} hidden={!fold.open}>
        {!data && <div aria-hidden className="td-sk-row" style={{ height: '1.75rem', border: 0 }} />}
        {disks.map((disk) => {
          const share = disk.usedBytes / disk.totalBytes
          const pct = Math.round(share * 100)
          return (
            <div key={disk.path} className="td-disk">
              <div className="td-disk-line">
                <span title={disk.path}>{disk.path}</span>
                <span>{t('today.ofSize', { done: fmtBytes(disk.usedBytes), total: fmtBytes(disk.totalBytes) })}</span>
              </div>
              <div
                role="meter"
                aria-label={t('dash.storageUsed', { path: disk.path, pct })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                className="td-meter"
                data-tone={pct >= 95 ? 'err' : pct >= 85 ? 'warn' : undefined}
                style={{ '--p': share } as CSSProperties}
              >
                <i />
              </div>
              {disk.paths?.map((p) => (
                <p key={p} className="td-sub" title={p}>
                  {p}
                </p>
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** What the machine is busy with, as one quiet line at the foot of the aside. */
function useWorkNote(): ReactNode {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const { data } = useQuery<JobsStatus>({
    queryKey: ['jobs', 'status'],
    queryFn: () => api.get('/api/jobs'),
    refetchInterval: 10_000,
  })
  const running = (data?.running ?? []).filter((f) => f !== 'suggestions')
  const paused = data?.paused ?? []
  if (running.length === 0 && paused.length === 0) return null
  const text = [
    running.length === 1
      ? t('jobs.busyOne', { name: jobLabel(t, running[0]) })
      : running.length > 1
        ? t('jobs.busy')
        : '',
    ...paused.map((f) => `${jobLabel(t, f)} ${t('jobs.paused')}`),
  ]
    .filter(Boolean)
    .join(', ')
  const cls = paused.length > 0 ? 'text-warn' : undefined
  return user?.isAdmin ? (
    <Link to="/settings/jobs" className={`t-link ${cls ?? ''}`}>
      {text}
    </Link>
  ) : (
    <span className={cls}>{text}</span>
  )
}
