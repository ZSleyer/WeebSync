import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Pause, Play, X } from 'lucide-react'
import { Button, Dialog, IconButton, Progress, SidePanel, morphTransition, useMediaQuery } from 'fluid-lycoris'
import { api, downloadLabel, fmtSpeed, type Download, type DownloadMeta } from '../api'
import { useAuth } from '../hooks'
import { GlobalLimitInput, QueueManager, SpeedPanel } from './QueueManager'
import { WIDE_MQ } from './PageActions'
import { useFailToast } from './toast'
import { TransfersCtx, type Transfers } from './transfers'

/**
 * The transfers in one place, from wherever the user is: on a phone the live
 * pill opens into a sheet (the hero morph, the pill growing into it), on a
 * desktop the sidebar's block opens a panel beside the page. Both show the
 * rate over time, the whole queue's brake (pause or resume all, the global
 * rate limit for an admin) and the running and waiting downloads as rows,
 * each to pause or go on with.
 */
export function TransfersProvider({ children, panel }: { children: ReactNode; panel?: HTMLElement | null }) {
  const [shown, setShown] = useState(false)
  const from = useRef<HTMLElement | null>(null)
  const wide = useMediaQuery(WIDE_MQ)
  const api = useMemo<Transfers>(
    () => ({
      open: (el) => {
        from.current = el ?? null
        // a phone's sheet grows out of the pill; a desktop's panel slides in
        if (!wide && el) void morphTransition(el, () => flushSync(() => setShown(true)), false, true)
        else setShown(true)
      },
      shown,
    }),
    [wide, shown],
  )
  return (
    <TransfersCtx.Provider value={api}>
      {children}
      {shown && <TransferView wide={wide} panel={panel} from={from} onClose={() => setShown(false)} />}
    </TransfersCtx.Provider>
  )
}

function TransferView({
  wide,
  panel,
  from,
  onClose,
}: {
  wide: boolean
  panel?: HTMLElement | null
  from: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const body = <TransferBody />
  if (wide) {
    const side = (
      <SidePanel
        aria-labelledby="transfers-title"
        onRequestClose={onClose}
        className="anim-route-push w-[clamp(24rem,28vw,28rem)] shrink-0"
      >
        <header className="flex items-center gap-2 border-b border-border-subtle px-5 py-4">
          <h3 id="transfers-title" className="flex-1 font-display font-semibold tracking-wider">
            {t('live.title')}
          </h3>
          <IconButton aria-label={t('common.close')} onClick={onClose}>
            <X aria-hidden />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{body}</div>
      </SidePanel>
    )
    return panel ? createPortal(side, panel) : side
  }
  const pill = from.current
  return (
    <Dialog
      onClose={onClose}
      sheet
      aria-labelledby="transfers-title"
      closeLabel={t('common.close')}
      bodyClassName="dialog-body"
      closeTransition={pill?.isConnected ? (close) => void morphTransition(pill, close, true, true) : undefined}
    >
      <header className="border-b border-border-subtle px-5 py-4">
        <h3 id="transfers-title" className="font-display font-semibold tracking-wider">
          {t('live.title')}
        </h3>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{body}</div>
    </Dialog>
  )
}

function TransferBody() {
  const { t } = useTranslation()
  const [manage, setManage] = useState(false)
  const qc = useQueryClient()
  const fail = useFailToast()
  const { data: downloads = [] } = useQuery<Download[]>({
    queryKey: ['downloads'],
    queryFn: () => api.get('/api/downloads'),
    refetchInterval: 5000,
  })
  const { data: meta } = useQuery<DownloadMeta>({
    queryKey: ['downloads', 'meta'],
    queryFn: () => api.get('/api/downloads/meta'),
    staleTime: 60_000,
  })
  const active = downloads
    .filter((d) => d.status === 'running' || d.status === 'queued' || d.status === 'paused')
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.queuePos - b.queuePos)
  const { data: user } = useAuth()
  const bulk = useMutation({
    mutationFn: (action: 'pause' | 'resume') => api.post('/api/downloads/bulk', { action, ids: [] }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
    onError: fail,
  })
  const anyActive = active.some((d) => d.status !== 'paused')
  const anyPaused = active.some((d) => d.status === 'paused')
  const act = (d: Download, verb: 'pause' | 'resume') =>
    api
      .post(`/api/downloads/${d.id}/${verb}`)
      .then(() => qc.invalidateQueries({ queryKey: ['downloads'] }))
      .catch(fail)

  return (
    // grid-cols-1 is minmax(0, 1fr): a bare grid sizes its one column to the
    // longest title and the limit row, and the sheet scrolled sideways on a phone
    <div className="grid grid-cols-1 gap-4">
      {active.some((d) => d.status === 'running') && <SpeedPanel downloads={active} />}
      {(anyActive || anyPaused || !!user?.isAdmin) && (
        <div className="flex flex-wrap items-center gap-2">
          {anyActive && (
            <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate('pause')}>
              <Pause aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
              {t('dash.pauseAll')}
            </Button>
          )}
          {anyPaused && (
            <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate('resume')}>
              <Play aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
              {t('dash.resumeAll')}
            </Button>
          )}
          {!!user?.isAdmin && <GlobalLimitInput caption />}
        </div>
      )}
      {active.length === 0 ? (
        <p className="text-sm text-t-secondary">{t('live.none')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {active.map((d) => {
            const { label, ep } = downloadLabel(d, meta)
            const running = d.status === 'running'
            const pct = d.size > 0 ? (d.transferred / d.size) * 100 : 0
            return (
              <li key={d.id} className="grid grid-cols-1 gap-1.5 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-t-primary">{label}</span>
                    <span className="block text-ctl-sm text-t-muted tabular-nums">
                      {[ep, running ? fmtSpeed(d.bytesPerSec ?? 0) : t(`status.${d.status}`)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <IconButton
                    aria-label={`${d.status === 'paused' ? t('dash.resume') : t('dash.pause')}: ${label}`}
                    onClick={() => act(d, d.status === 'paused' ? 'resume' : 'pause')}
                  >
                    {d.status === 'paused' ? <Play aria-hidden /> : <Pause aria-hidden />}
                  </IconButton>
                </div>
                <Progress value={pct} size="sm" wave active={running} label={`${label} ${ep}`.trim()} />
              </li>
            )
          })}
        </ul>
      )}
      {/* the whole queue to manage (reorder, limits, selection, the
          finished ones), folded until asked for: it left the Today page */}
      <button
        type="button"
        className="t-link justify-self-start"
        aria-expanded={manage}
        onClick={() => setManage((m) => !m)}
      >
        {t('live.manage')}
      </button>
      {manage && <QueueManager />}
    </div>
  )
}
