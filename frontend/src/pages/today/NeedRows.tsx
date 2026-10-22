import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { CircleAlert, FolderPlus, Info, KeyRound, RotateCcw, Server, ShieldAlert, Trash2, X } from 'lucide-react'
import { afterBackEntry, Button, Dialog, haptic, IconButton, SHEET_MQ, useMediaQuery } from 'fluid-lycoris'
import { api, type Download, type DownloadMeta, type ServerInfo, type Watch } from '../../api'
import ActionMenu from '../../components/ActionMenu'
import FtpsMigrateDialog from '../../components/FtpsMigrate'
import type { SheetAction } from '../../components/ActionSheet'
import { filesLink } from '../../components/playLinks'
import { useSeriesModal } from '../../components/SeriesModal'
import { useToast } from '../../components/toast'
import { useAuth, useNow } from '../../hooks'
import { buildNeeds, detectedLink, hiddenNeeds, hideForSession, saveHidden, sessionOnly, type Need } from './needs'
import { seriesTarget, useTodayJump } from './shared'

// The rows of the needs list and what they do, shared by the Today section
// and the full page: one implementation of the swipe, the detail sheet, the
// hide and its undo, and the actions behind each kind of row.

const TAUGHT_KEY = 'weebsync.today.taught'

const still = () =>
  document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A row that a finger can throw aside: to the right it runs the row's
 * action, to the left it hides the row. Past 35% of the width or thrown, the
 * row flies out and `onCommit` runs; short of it, it springs back. Touch and
 * pen only; the action button stays for everyone else (WCAG 2.5.7).
 */
function useCommitSwipe(onCommit: (side: 'act' | 'hide') => void) {
  const swallow = useRef(false)
  const onPointerDown = (e: ReactPointerEvent<HTMLLIElement>) => {
    if (e.pointerType === 'mouse' || e.button) return
    const row = e.currentTarget
    const inner = row.querySelector<HTMLElement>('.t-row-in')
    if (!inner) return
    const x0 = e.clientX
    const y0 = e.clientY
    let mode: 'x' | 'y' | null = null
    let dx = 0
    const samples: [number, number][] = [[e.timeStamp, x0]]
    const move = (ev: PointerEvent) => {
      const mx = ev.clientX - x0
      const my = ev.clientY - y0
      if (!mode) {
        if (Math.hypot(mx, my) < 6) return
        mode = Math.abs(mx) > Math.abs(my) * 1.2 ? 'x' : 'y'
        if (mode === 'y') return cleanup()
        row.setPointerCapture(ev.pointerId)
        inner.style.transition = 'none'
      }
      dx = mx
      // a rubber band past the action's width
      const w = row.clientWidth * 0.45
      const v = Math.abs(dx) > w ? Math.sign(dx) * (w + (Math.abs(dx) - w) * 0.25) : dx
      inner.style.transform = `translateX(${v}px)`
      row.dataset.side = dx < 0 ? 'r' : 'l'
      samples.push([ev.timeStamp, ev.clientX])
      while (samples.length > 2 && ev.timeStamp - samples[0][0] > 100) samples.shift()
    }
    const up = (ev: PointerEvent) => {
      cleanup()
      if (mode !== 'x') return
      swallow.current = true
      setTimeout(() => (swallow.current = false), 0)
      const [t0, xs] = samples[0]
      const vel = (ev.clientX - xs) / Math.max(1, ev.timeStamp - t0)
      const commit = Math.abs(dx) > row.clientWidth * 0.35 || (Math.abs(vel) > 0.5 && Math.sign(vel) === Math.sign(dx))
      inner.style.transition = ''
      if (!commit) {
        inner.animate([{ transform: inner.style.transform }, { transform: 'none' }], {
          duration: still() ? 1 : 380,
          easing: getComputedStyle(document.documentElement).getPropertyValue('--spring') || 'ease-out',
        })
        inner.style.transform = ''
        delete row.dataset.side
        return
      }
      haptic(12)
      const out = Math.sign(dx) * row.clientWidth
      inner
        .animate([{ transform: inner.style.transform }, { transform: `translateX(${out}px)` }], {
          duration: still() ? 1 : 180,
          easing: 'cubic-bezier(.4,0,1,1)',
          fill: 'forwards',
        })
        .finished.then(() => {
          onCommit(dx < 0 ? 'hide' : 'act')
          // a row that stays (an explanation) comes back to rest
          inner.getAnimations().forEach((a) => a.cancel())
          inner.style.transform = ''
          delete row.dataset.side
        })
    }
    const cancel = () => {
      cleanup()
      inner.style.transition = ''
      inner.style.transform = ''
      delete row.dataset.side
    }
    const cleanup = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', cancel)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', cancel)
  }
  const onClickCapture = (e: React.MouseEvent) => {
    if (!swallow.current) return
    e.preventDefault()
    e.stopPropagation()
  }
  return { onPointerDown, onClickCapture }
}

const ICONS = {
  failed: CircleAlert,
  watch: Info,
  marks: FolderPlus,
  plex: KeyRound,
  ftp: ShieldAlert,
}

/** the icon that stands for a row's primary action where the label has no room */
function actIcon(n: Need, size: string) {
  const Ico = n.kind === 'failed' ? (n.auth ? Server : RotateCcw) : ICONS[n.kind]
  return <Ico aria-hidden size={size} />
}

type DetailAction = SheetAction & { primary?: boolean }

/**
 * A row in full: what it is, why, the backend's own words for a failure, and
 * every action as a labelled button. Taking one closes the sheet first and
 * then runs exactly what the row's own button runs.
 */
export function NeedDetail({ n, actions, onClose }: { n: Need; actions: DetailAction[]; onClose: () => void }) {
  const Icon = ICONS[n.kind]
  return (
    <Dialog width="max-w-sm" onClose={onClose} aria-labelledby="need-detail-title">
      <div className="grid gap-3 px-5 pt-4 pb-5">
        <header className="flex items-start gap-3">
          <span
            aria-hidden
            className="t-glyph"
            data-tone={n.tone === 'accent-2' ? 'accent-2' : n.tone === 'err' ? 'err' : 'accent'}
          >
            <Icon size={20} />
          </span>
          <h2 id="need-detail-title" className="font-display text-lg font-semibold break-words">
            {n.title}
          </h2>
        </header>
        <p className="text-[0.9375rem] break-words text-fg-2">{n.sub}</p>
        {n.raw && <p className="rounded-md bg-hover p-2 font-mono text-xs break-words text-fg-3">{n.raw}</p>}
        <div className="grid gap-2 pt-1">
          {actions.map((a) => (
            <Button
              key={a.key}
              variant={a.primary ? 'primary' : undefined}
              className={`w-full justify-start gap-3 ${a.danger ? 'text-err' : ''}`}
              onClick={() => {
                onClose()
                // the sheet's own history step first, as the action sheet does
                afterBackEntry(a.onClick)
              }}
            >
              {a.icon}
              {a.label}
            </Button>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

export function NeedRow({
  n,
  teach,
  menu,
  onAct,
  onHide,
}: {
  n: Need
  teach: boolean
  /** a failed row's other actions; the rest get a plain Hide button */
  menu?: SheetAction[]
  onAct: () => void
  onHide: () => void
}) {
  const { t } = useTranslation()
  const swipe = useCommitSwipe((side) => (side === 'act' ? onAct() : onHide()))
  // on a phone the action is an icon and the row opens in full; where there is room the label stays
  const compact = useMediaQuery(SHEET_MQ)
  const [detail, setDetail] = useState(false)
  const Icon = ICONS[n.kind]
  const actLabel = `${n.act}: ${n.title}`
  const text = (
    <>
      <strong>{n.title}</strong>
      <span title={n.raw ? `${n.sub}\n${n.raw}` : n.sub}>{n.sub}</span>
    </>
  )
  const detailActions = (): DetailAction[] => {
    const ico = { 'aria-hidden': true, size: '1.1em' } as const
    const rest = menu ?? []
    // a row's own Hide or Remove sits in its menu already
    const closes = rest.some((a) => a.key === 'hide' || a.key === 'remove')
    return [
      {
        key: 'act',
        label: n.act,
        icon: actIcon(n, '1.1em'),
        onClick: onAct,
        primary: true,
      },
      ...rest,
      ...(closes
        ? []
        : [
            {
              key: 'hide',
              label: t('today.hide'),
              icon: <X {...ico} />,
              onClick: onHide,
            },
          ]),
    ]
  }
  return (
    <li className={`t-row${teach ? ' td-teach' : ''}`} {...swipe}>
      <div className="td-under" aria-hidden>
        <span className="l">{n.act}</span>
        <span className="r">{n.kind === 'failed' ? t('today.removeFailed') : t('today.hide')}</span>
      </div>
      <div className="t-row-in">
        <span aria-hidden className="t-glyph" data-tone={n.tone === 'accent-2' ? 'accent-2' : undefined}>
          <Icon size={18} />
        </span>
        {compact ? (
          <button type="button" className="t-row-t td-row-open" aria-haspopup="dialog" onClick={() => setDetail(true)}>
            {text}
          </button>
        ) : (
          <div className="t-row-t">{text}</div>
        )}
        {compact ? (
          <IconButton
            aria-label={actLabel}
            title={n.act}
            onClick={onAct}
            className={n.why ? 'text-accent-2' : 'text-accent'}
          >
            {actIcon(n, '1.2em')}
          </IconButton>
        ) : (
          <button
            type="button"
            className={`t-row-act${n.why ? ' t-row-act--2' : ''}`}
            onClick={onAct}
            aria-label={actLabel}
          >
            {n.act}
          </button>
        )}
        {menu ? (
          <ActionMenu label={t('dash.moreActions', { name: n.title })} title={n.title} actions={menu} />
        ) : (
          <IconButton aria-label={`${t('today.hide')}: ${n.title}`} title={t('today.hide')} onClick={onHide}>
            <X aria-hidden size="1.1em" />
          </IconButton>
        )}
      </div>
      {detail && <NeedDetail n={n} actions={detailActions()} onClose={() => setDetail(false)} />}
    </li>
  )
}

export interface NeedListData {
  downloads: Download[]
  meta?: DownloadMeta
  watches: Watch[]
  /** folders WeebSync marked on its own that the user has not looked at yet */
  detected: number
  /** an admin's Plex runs on a pasted token */
  plexToken?: boolean
  /** Plex and Jellyfin both connected, neither chosen */
  mediaChoose?: boolean
}

/**
 * The needs, the rows' handlers and the dialogs they open. `shown` is every
 * row not hidden, in the list's order; `row` draws one with its actions.
 * Rows hidden here are stored, so every page that lists the needs agrees.
 */
export function useNeedList({ downloads, meta, watches, detected, plexToken, mediaChoose }: NeedListData) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const now = useNow()
  const { data: me } = useAuth()
  const { open } = useSeriesModal()
  const [jump] = useTodayJump()
  const { data: servers = [] } = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
    staleTime: 60_000,
  })
  const serverNames = Object.fromEntries(servers.map((x) => [x.id, x.name]))
  const [hidden, setHidden] = useState(hiddenNeeds)
  // rows that left and wait for their toast to run out
  const [gone, setGone] = useState<Set<string>>(new Set())
  const ftpServers = servers.filter((x) => x.protocol === 'ftp')
  const [migrating, setMigrating] = useState<ServerInfo | null>(null)
  const all = buildNeeds(t, {
    downloads,
    meta,
    watches,
    detected,
    now,
    plexToken,
    mediaChoose,
    serverNames,
    ftpServers,
  })
  const live = all.filter((n) => !hidden.has(n.print))
  const shown = live.filter((n) => !gone.has(n.key))
  // the swipe is taught once, on a touch screen, by a nudge of the first row
  const [teach, setTeach] = useState(false)
  const anyRow = shown.length > 0
  useEffect(() => {
    if (!anyRow || !matchMedia('(hover: none)').matches) return
    try {
      if (localStorage.getItem(TAUGHT_KEY)) return
      localStorage.setItem(TAUGHT_KEY, '1')
    } catch {
      return
    }
    const id = setTimeout(() => setTeach(true), 0)
    return () => clearTimeout(id)
  }, [anyRow])

  // one failed download or a whole group of them
  const resume = useMutation({
    mutationFn: (ds: Download[]) =>
      ds.length === 1
        ? api.post(`/api/downloads/${ds[0].id}/resume`)
        : api.post('/api/downloads/bulk', {
            action: 'resume',
            ids: ds.map((d) => d.id),
          }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  })
  const discard = useMutation({
    mutationFn: (ds: Download[]) =>
      ds.length === 1
        ? api.del(`/api/downloads/${ds[0].id}`)
        : api.post('/api/downloads/bulk', {
            action: 'delete',
            ids: ds.map((d) => d.id),
          }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  })

  const unGone = (n: Need) =>
    setGone((g) => {
      const next = new Set(g)
      next.delete(n.key)
      return next
    })
  const leave = (n: Need, message: string, commit: () => void | Promise<unknown>) => {
    setGone((g) => new Set(g).add(n.key))
    toast({ message, undo: () => unGone(n), commit })
  }
  // a group's key outlives its members, so the row may only come back (for a
  // later failure of the same cause) once the list no longer holds them
  const leaveFailed = (n: Need, message: string, run: (ds: Download[]) => Promise<unknown>) => {
    const ds = n.group ?? (n.download ? [n.download] : [])
    leave(n, message, () =>
      run(ds)
        .catch(() => {})
        .then(() => qc.invalidateQueries({ queryKey: ['downloads'] }))
        .finally(() => unGone(n)),
    )
  }
  const retry = (n: Need) => {
    const count = n.group?.length ?? 1
    leaveFailed(n, count > 1 ? t('today.retriedMany', { count }) : t('today.retried', { what: n.title }), (ds) =>
      resume.mutateAsync(ds),
    )
  }
  const remove = (n: Need) =>
    leaveFailed(n, t('today.removedFailed', { count: n.group?.length ?? 1 }), (ds) => discard.mutateAsync(ds))
  const checkServer = () => navigate('/settings/servers')
  const act = (n: Need) => {
    if (n.kind === 'ftp') {
      setMigrating(ftpServers.find((x) => x.id === n.serverId) ?? null)
      return
    }
    if (n.kind === 'plex') {
      // the sign-in and the choice live with the servers; the row goes once done
      navigate(n.key === 'media-choose' ? '/settings/integrations#media' : '/settings/integrations#plex')
      return
    }
    if (n.why && n.watch) {
      const w = n.watch
      if (w.attention?.[0] === 'unsorted' && w.localPath) navigate(filesLink(0, w.localPath))
      else if (w.media) open(jump ? { ...seriesTarget(w), tab: 'episodes' } : seriesTarget(w))
      else navigate('/watches?filter=attention')
      return
    }
    if (n.kind === 'failed') {
      // a refused login is fixed at the server, not by trying again
      if (n.auth) checkServer()
      else retry(n)
    } else if (n.kind === 'marks') {
      // the list marks them seen when it opens; the row goes with the count
      navigate(detectedLink(!!me?.isAdmin))
    }
  }
  const hide = (n: Need) =>
    n.kind === 'failed'
      ? remove(n)
      : leave(n, t('today.hidden'), () => {
          setHidden((h) => {
            const next = new Set(h).add(n.print)
            // a plain-FTP row only steps aside for this tab: the server stays broken
            if (sessionOnly(n)) hideForSession(n.print)
            else saveHidden(next, all)
            return next
          })
        })

  // a failed row's other actions, next to the primary one
  const menuFor = (n: Need): SheetAction[] | undefined => {
    const ico = { 'aria-hidden': true, size: '1.1em' } as const
    if (n.kind !== 'failed') return undefined
    const many = (n.group?.length ?? 1) > 1
    return [
      ...(n.auth
        ? [
            {
              key: 'retry',
              label: many ? t('today.retryAll') : t('dash.retry'),
              icon: <RotateCcw {...ico} />,
              onClick: () => retry(n),
            },
          ]
        : n.serverId !== undefined
          ? [
              {
                key: 'server',
                label: t('today.checkServer'),
                icon: <Server {...ico} />,
                onClick: checkServer,
              },
            ]
          : []),
      {
        key: 'remove',
        label: many ? t('today.removeFailedAll') : t('today.removeFailed'),
        icon: <Trash2 {...ico} />,
        danger: true,
        onClick: () => remove(n),
      },
    ]
  }

  const row = (n: Need, i: number) => (
    <NeedRow key={n.key} n={n} teach={teach && i === 0} menu={menuFor(n)} onAct={() => act(n)} onHide={() => hide(n)} />
  )
  const dialog = migrating ? <FtpsMigrateDialog server={migrating} onClose={() => setMigrating(null)} /> : null
  return { shown, row, dialog }
}
