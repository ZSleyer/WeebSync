import { Pause, Play, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Panel, Select } from '@weebsync/design-system'
import { api, type JobsStatus } from '../../api'
import { jobFamily, jobLabel } from '../../jobs'
import { fmtLogTime, LOG_COLOR, LOG_LEVELS, useAdminJobs, type LogLevel, type LogLine } from './maintenance'

// LogPanel is the admin live log: an SSE stream of backend records (backlog
// first, then live) with a runtime level switch, a client-side level filter,
// pause and clear. Modelled on useEvents (hooks.ts) but keeps its own capped
// buffer instead of a react-query cache.
function LogPanel({ level }: { level: LogLevel }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [lines, setLines] = useState<LogLine[]>([])
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<LogLevel | 'all'>('all')
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const endRef = useRef<HTMLDivElement>(null)

  const setLevel = useMutation({
    mutationFn: (lvl: LogLevel) => api.put('/api/admin/loglevel', { level: lvl }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['adminJobs'] }),
  })

  useEffect(() => {
    const es = new EventSource('/api/admin/logs/stream')
    es.onmessage = (ev) => {
      if (pausedRef.current) return
      let line: LogLine
      try {
        line = JSON.parse(ev.data)
      } catch {
        return // ignore keepalive/malformed frames
      }
      // cap at 500 so a chatty trace level can't grow the DOM unbounded
      setLines((old) => (old.length >= 500 ? [...old.slice(old.length - 499), line] : [...old, line]))
    }
    // a 401 (expired session) otherwise reconnect-loops forever; re-check auth
    es.onerror = () => qc.invalidateQueries({ queryKey: ['me'] })
    return () => es.close()
  }, [qc])

  const shown = filter === 'all' ? lines : lines.filter((l) => l.level === filter)

  useEffect(() => {
    if (!paused) endRef.current?.scrollIntoView({ block: 'end' })
  }, [shown.length, paused])

  const fmtAttrs = (a?: Record<string, unknown>) =>
    a
      ? Object.entries(a)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
      : ''

  return (
    <Panel as="section" id="log" className="mb-4 p-5" aria-label={t('settings.jobs.logs.title')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone="accent">{t('settings.jobs.logs.title')}</Badge>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-t-muted" htmlFor="log-level">
            {t('settings.jobs.logs.level')}
          </label>
          <Select
            id="log-level"
            size="sm"
            value={level}
            disabled={setLevel.isPending}
            onChange={(e) => setLevel.mutate(e.target.value as LogLevel)}
          >
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          <label className="text-xs text-t-muted" htmlFor="log-filter">
            {t('settings.jobs.logs.filter')}
          </label>
          <Select
            id="log-filter"
            size="sm"
            value={filter}
            onChange={(e) => setFilter(e.target.value as LogLevel | 'all')}
          >
            <option value="all">{t('settings.jobs.logs.all')}</option>
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          <Button size="sm" onClick={() => setPaused((p) => !p)}>
            {paused ? (
              <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            ) : (
              <Pause aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            )}
            {paused ? t('settings.jobs.logs.resume') : t('settings.jobs.logs.pause')}
          </Button>
          <Button size="sm" onClick={() => setLines([])}>
            <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('settings.jobs.logs.clear')}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-t-muted">{t('settings.jobs.logs.hint')}</p>
      <div className="mt-3 h-[50dvh] overflow-y-auto rounded-lg border border-border-subtle bg-bg-secondary p-2 font-mono text-xs leading-relaxed lg:h-auto lg:max-h-[60dvh]">
        {shown.length === 0 ? (
          <p className="text-t-secondary">{t('settings.jobs.logs.empty')}</p>
        ) : (
          shown.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap wrap-break-word">
              <span className="text-t-muted">{fmtLogTime(l.ts)}</span>{' '}
              <span className={`${LOG_COLOR[l.level] ?? ''} font-semibold uppercase`}>{l.level}</span>{' '}
              <span>{l.msg}</span>
              {l.attrs && Object.keys(l.attrs).length > 0 && <span className="text-t-muted"> {fmtAttrs(l.attrs)}</span>}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </Panel>
  )
}

// Tasks and log: what runs right now, what is held, and the live stream
// of the backend's records. The index, the matches and the data inventory
// have sections of their own.
export default function Jobs() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const { data } = useAdminJobs()
  // the paused set lives on the small status endpoint, which the dashboard
  // reads too - one source, so the two views cannot disagree
  const { data: jobsStatus } = useQuery<JobsStatus>({
    queryKey: ['jobs', 'status'],
    queryFn: () => api.get('/api/jobs'),
    refetchInterval: 5000,
  })
  // Holding a task is two things at once, because that is what "make it stop"
  // means: the family stops starting, and the pass that is running right now is
  // cancelled. Resuming only lifts the first - the next sweep starts it again.
  const hold = useMutation({
    mutationFn: async ({ family, paused }: { family: string; paused: boolean }) => {
      await api.post('/api/admin/jobs/pause', { family, paused })
      if (paused) await api.post(`/api/admin/jobs/${family}/stop`)
    },
    onSuccess: () => {
      setError('')
      qc.invalidateQueries({ queryKey: ['adminJobs'] })
      qc.invalidateQueries({ queryKey: ['jobs', 'status'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  if (!data) return null
  const idle = data.running.length === 0

  return (
    <>
      {error && (
        <p className="mb-3 text-xs text-err" role="alert">
          {error}
        </p>
      )}
      <Panel as="section" id="activity" className="mb-4 p-5" aria-label={t('settings.jobs.activity')}>
        <Badge tone="accent">{t('settings.jobs.activity')}</Badge>
        <p className="mt-2 text-xs text-t-muted">{t('settings.jobs.hint')}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {idle && <Badge tone="ok">{t('settings.jobs.idle')}</Badge>}
          {data.running.map((job) => (
            <span key={job} className="flex items-center gap-1">
              <Badge className="font-mono">{job}</Badge>
              <Button
                size="sm"
                title={t('jobs.holdHint')}
                aria-label={`${t('jobs.hold')}: ${jobLabel(t, jobFamily(job))}`}
                disabled={hold.isPending}
                onClick={() => hold.mutate({ family: jobFamily(job), paused: true })}
              >
                <Pause aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('jobs.hold')}
              </Button>
            </span>
          ))}
          {(jobsStatus?.paused ?? []).map((family) => (
            <span key={family} className="flex items-center gap-1">
              <Badge tone="warn">
                {jobLabel(t, family)} · {t('jobs.paused')}
              </Badge>
              <Button
                size="sm"
                aria-label={`${t('jobs.resume')}: ${jobLabel(t, family)}`}
                disabled={hold.isPending}
                onClick={() => hold.mutate({ family, paused: false })}
              >
                <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                {t('jobs.resume')}
              </Button>
            </span>
          ))}
          {data.matchQueue > 0 && (
            <Badge tone="warn" className="tabular-nums">
              {t('settings.jobs.queue', { count: data.matchQueue })}
            </Badge>
          )}
        </div>
        {(jobsStatus?.paused ?? []).length > 0 && (
          <p className="mt-2 text-xs text-warn">{t('jobs.pausedNote')}</p>
        )}
        <p className="mt-2 text-xs text-t-muted">
          {t('settings.jobs.watchSummary', { count: data.watch.count, min: data.watch.intervalMin })}
        </p>
      </Panel>

      <LogPanel level={data.logLevel} />
    </>
  )
}
