import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { CircleAlert, FolderPlus, Info } from 'lucide-react'
import { haptic, SectionHeading } from 'fluid-lycoris'
import { api, type Download, type DownloadMeta, type ScopeHint, type Watch } from '../../api'
import { filesLink } from '../../components/playLinks'
import { useSeriesModal } from '../../components/SeriesModal'
import { useToast } from '../../components/toast'
import { scopeChanged } from '../../components/useCatalogView'
import { useNow } from '../../hooks'
import { buildNeeds, hiddenNeeds, saveHidden, type Need } from './needs'
import { seriesTarget, useFold, useRiseOnData } from './shared'

/** rows shown before "N more" */
const NEEDS_MAX = 5
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

const ICONS = { failed: CircleAlert, watch: Info, hint: FolderPlus }

function NeedRow({ n, teach, onAct, onHide }: { n: Need; teach: boolean; onAct: () => void; onHide: () => void }) {
  const { t } = useTranslation()
  const swipe = useCommitSwipe((side) => (side === 'act' ? onAct() : onHide()))
  const Icon = ICONS[n.kind]
  return (
    <li className={`t-row${teach ? ' td-teach' : ''}`} {...swipe}>
      <div className="td-under" aria-hidden>
        <span className="l">{n.act}</span>
        <span className="r">{t('today.hide')}</span>
      </div>
      <div className="t-row-in">
        <span aria-hidden className="t-glyph" data-tone={n.tone === 'accent-2' ? 'accent-2' : undefined}>
          <Icon size={18} />
        </span>
        <div className="t-row-t">
          <strong>{n.title}</strong>
          <span title={n.sub}>{n.sub}</span>
        </div>
        <button
          type="button"
          className={`t-row-act${n.why ? ' t-row-act--2' : ''}`}
          onClick={onAct}
          aria-label={`${n.act}: ${n.title}`}
        >
          {n.act}
        </button>
      </div>
    </li>
  )
}

/**
 * "Braucht dich": what needs a hand, one row each with its reason and one
 * action. A swipe to the right runs the action, to the left hides the row;
 * either leaves at once and can be taken back from the toast.
 */
export function Needs({
  downloads,
  meta,
  watches,
  hints,
  loading,
}: {
  downloads: Download[]
  meta?: DownloadMeta
  watches: Watch[]
  hints: ScopeHint[]
  loading: boolean
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const now = useNow()
  const { open } = useSeriesModal()
  const [hidden, setHidden] = useState(hiddenNeeds)
  // rows that left and wait for their toast to run out
  const [gone, setGone] = useState<Set<string>>(new Set())
  const all = buildNeeds(t, { downloads, meta, watches, hints, now })
  const live = all.filter((n) => !hidden.has(n.print))
  const shown = live.filter((n) => !gone.has(n.key))
  const body = useRef<HTMLDivElement>(null)
  useRiseOnData(body, !loading)

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

  const resume = useMutation({
    mutationFn: (d: Download) => api.post(`/api/downloads/${d.id}/resume`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  })
  const mark = useMutation({
    mutationFn: (h: ScopeHint) => api.put(`/api/servers/${h.serverId}/catalog/scope`, { path: h.path, kind: h.kind }),
    onSuccess: (_, h) => scopeChanged(qc, h.serverId),
  })

  const leave = (n: Need, message: string, commit: () => void) => {
    setGone((g) => new Set(g).add(n.key))
    toast({
      message,
      undo: () =>
        setGone((g) => {
          const next = new Set(g)
          next.delete(n.key)
          return next
        }),
      commit,
    })
  }
  const act = (n: Need) => {
    if (n.why && n.watch) {
      const w = n.watch
      if (w.attention?.[0] === 'unsorted' && w.localPath) navigate(filesLink(0, w.localPath))
      else if (w.media) open({ ...seriesTarget(w), tab: 'episodes' })
      else navigate('/watches?filter=attention')
      return
    }
    if (n.download) {
      const d = n.download
      leave(n, t('today.retried', { what: n.title }), () => resume.mutate(d))
    } else if (n.hint) {
      const h = n.hint
      leave(n, t('today.marked', { name: h.name }), () => mark.mutate(h))
    }
  }
  const hide = (n: Need) =>
    leave(n, t('today.hidden'), () =>
      setHidden((h) => {
        const next = new Set(h).add(n.print)
        saveHidden(next, all)
        return next
      }),
    )

  const rows = shown.slice(0, NEEDS_MAX)
  const fold = useFold('needs')
  return (
    <section aria-labelledby="td-needs-h">
      <SectionHeading
        id="td-needs-h"
        title={t('today.needs')}
        action={!loading && <span className="td-count">{shown.length}</span>}
        fold={fold}
      />
      <div ref={body} id={fold.controls} hidden={!fold.open}>
        <ul className="t-rows td-needs">
          {loading
            ? [0, 1].map((i) => <li key={i} aria-hidden className="td-sk-row" />)
            : rows.map((n, i) => (
                <NeedRow key={n.key} n={n} teach={teach && i === 0} onAct={() => act(n)} onHide={() => hide(n)} />
              ))}
          {!loading && rows.length === 0 && <li className="td-empty">{t('today.nothingOpen')}</li>}
        </ul>
        {shown.length > rows.length && (
          <Link to="/watches?filter=attention" className="t-link td-more">
            {t('dash.attentionMore', { count: shown.length - rows.length })}
          </Link>
        )}
      </div>
    </section>
  )
}
