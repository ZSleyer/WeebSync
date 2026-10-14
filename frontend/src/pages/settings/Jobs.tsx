import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, Row, Rows, Select } from 'fluid-lycoris'
import { api, type JobsStatus } from '../../api'
import { jobFamily, jobLabel } from '../../jobs'
import { fmtLogTime, LOG_COLOR, LOG_LEVELS, useAdminJobs, type LogLevel, type LogLine } from './maintenance'
import { SettingsPanel } from './ui'
import './maintenance.css'

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
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])
  const logRef = useRef<HTMLPreElement>(null)

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

  // follow the newest line. Keyed on the buffer itself, not its length: at
  // the cap the length stops changing while lines keep arriving. The log box
  // scrolls itself; scrollIntoView would drag the whole page along
  useEffect(() => {
    const box = logRef.current
    if (!paused && box) box.scrollTop = box.scrollHeight
  }, [lines, filter, paused])

  const fmtAttrs = (a?: Record<string, unknown>) =>
    a
      ? Object.entries(a)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
      : ''

  return (
    <SettingsPanel id="log" title={t('settings.jobs.logs.title')} desc={t('settings.jobs.logs.hint')}>
      <div className="log-bar">
        <Select
          size="sm"
          aria-label={t('settings.jobs.logs.level')}
          title={t('settings.jobs.logs.level')}
          value={level}
          disabled={setLevel.isPending}
          onChange={(e) => setLevel.mutate(e.target.value as LogLevel)}
        >
          {LOG_LEVELS.map((l) => (
            <option key={l} value={l}>
              {t('settings.jobs.logs.levelIs', { level: l })}
            </option>
          ))}
        </Select>
        <Select
          size="sm"
          aria-label={t('settings.jobs.logs.filter')}
          title={t('settings.jobs.logs.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value as LogLevel | 'all')}
        >
          <option value="all">{t('settings.jobs.logs.showAll')}</option>
          {LOG_LEVELS.map((l) => (
            <option key={l} value={l}>
              {t('settings.jobs.logs.showOnly', { level: l })}
            </option>
          ))}
        </Select>
        <Button size="sm" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
          {paused ? t('settings.jobs.logs.resume') : t('settings.jobs.logs.pause')}
        </Button>
        <Button size="sm" onClick={() => setLines([])}>
          {t('settings.jobs.logs.clear')}
        </Button>
      </div>
      {/* a scrolling region a keyboard has to reach: focusable, named (axe
          scrollable-region-focusable) */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <pre ref={logRef} className="log" tabIndex={0} aria-label={t('settings.jobs.logs.title')}>
        {shown.length === 0
          ? t('settings.jobs.logs.empty')
          : shown.map((l, i) => (
              <div key={i}>
                <span className="opacity-70">{fmtLogTime(l.ts)}</span>{' '}
                <span className={`${LOG_COLOR[l.level] ?? ''} font-semibold uppercase`}>{l.level}</span> {l.msg}
                {l.attrs && Object.keys(l.attrs).length > 0 && <span className="opacity-70"> {fmtAttrs(l.attrs)}</span>}
              </div>
            ))}
      </pre>
    </SettingsPanel>
  )
}

// Tasks and log: what runs right now and what is held, then the live stream
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
  const held = jobsStatus?.paused ?? []
  const idle = data.running.length === 0 && held.length === 0

  return (
    <>
      {error && (
        <p className="sf-issue mb-3" role="alert">
          {error}
        </p>
      )}
      <SettingsPanel id="activity" title={t('settings.jobs.activity')} desc={t('settings.jobs.hint')}>
        {idle ? (
          <p className="sf-note">{t('settings.jobs.idleLine')}</p>
        ) : (
          <Rows dense>
            {data.running.map((job) => {
              const name = jobLabel(t, jobFamily(job))
              return (
                <Row
                  key={job}
                  leading={<span className="run-dot" />}
                  title={name}
                  sub={
                    <>
                      {t('settings.jobs.running')} · <span className="font-mono">{job}</span>
                    </>
                  }
                  trailing={
                    <Button
                      size="sm"
                      title={t('jobs.holdHint')}
                      aria-label={`${t('jobs.hold')}: ${name}`}
                      disabled={hold.isPending}
                      onClick={() => hold.mutate({ family: jobFamily(job), paused: true })}
                    >
                      {t('jobs.hold')}
                    </Button>
                  }
                />
              )
            })}
            {held.map((family) => (
              <Row
                key={family}
                leading={<span className="run-dot held" />}
                title={jobLabel(t, family)}
                sub={t('jobs.paused')}
                trailing={
                  <Button
                    size="sm"
                    aria-label={`${t('jobs.resume')}: ${jobLabel(t, family)}`}
                    disabled={hold.isPending}
                    onClick={() => hold.mutate({ family, paused: false })}
                  >
                    {t('jobs.resume')}
                  </Button>
                }
              />
            ))}
          </Rows>
        )}
        {held.length > 0 && <p className="sf-note">{t('jobs.pausedNote')}</p>}
        <p className="sf-note">
          {t('settings.jobs.watchSummary', { count: data.watch.count, min: data.watch.intervalMin })}
          {data.matchQueue > 0 && <> · {t('settings.jobs.queue', { count: data.matchQueue })}</>}
        </p>
      </SettingsPanel>

      <LogPanel level={data.logLevel} />
    </>
  )
}
