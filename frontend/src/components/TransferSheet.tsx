import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { Pause, Play, X } from 'lucide-react'
import { Dialog, IconButton, Progress, SidePanel, morphTransition, useMediaQuery } from 'fluid-lycoris'
import { api, downloadLabel, fmtSpeed, type Download, type DownloadMeta } from '../api'
import { SpeedPanel } from '../pages/Dashboard'
import { WIDE_MQ } from './PageActions'
import { useFailToast } from './toast'
import { TransfersCtx, type Transfers } from './transfers'

/**
 * The transfers in one place, from wherever the user is: on a phone the live
 * pill opens into a sheet (the hero morph, the pill growing into it), on a
 * desktop the sidebar's block opens a panel beside the page. Both show the
 * rate over time and the running and waiting downloads as rows, each to pause
 * or go on with.
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
    }),
    [wide],
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
  const { pathname } = useLocation()
  const body = <TransferBody onLeave={pathname === '/' ? undefined : onClose} />
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

function TransferBody({ onLeave }: { onLeave?: () => void }) {
  const { t } = useTranslation()
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
  const act = (d: Download, verb: 'pause' | 'resume') =>
    api
      .post(`/api/downloads/${d.id}/${verb}`)
      .then(() => qc.invalidateQueries({ queryKey: ['downloads'] }))
      .catch(fail)

  return (
    <div className="grid gap-4">
      {active.some((d) => d.status === 'running') && <SpeedPanel downloads={active} />}
      {active.length === 0 ? (
        <p className="text-sm text-t-secondary">{t('live.none')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {active.map((d) => {
            const { label, ep } = downloadLabel(d, meta)
            const running = d.status === 'running'
            const pct = d.size > 0 ? (d.transferred / d.size) * 100 : 0
            return (
              <li key={d.id} className="grid gap-1.5 py-2.5">
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
      {onLeave && (
        <Link to="/" onClick={onLeave} className="text-sm text-accent hover:underline">
          {t('live.manage')}
        </Link>
      )}
    </div>
  )
}
