import { useEffect, useLayoutEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Check, RefreshCw } from 'lucide-react'
import { haptic, useMediaQuery } from '@weebsync/design-system'
import { WIDE_MQ } from './PageActions'

// How far a phone page has to scroll before the large title has gone and the
// app bar's title takes over: about the title's own height.
const DOCK_PX = 56
// the ring's circumference at r = 20 in a 44 box
const RING = 2 * Math.PI * 20

const clamp = (v: number) => Math.min(1, Math.max(0, v))

// Pull to refresh: how far the page has to come down before letting go
// reloads it, and how far it can come down at all. The finger travels about
// twice as far as the page - the resistance is what says it is a pull.
const PULL_AT = 64
const PULL_MAX = 96
// the spinner stays at least this long, or a fast answer reads as a flicker
const PULL_MIN_MS = 600
// and the "refreshed" line stays this long before the page goes back up
const DONE_MS = 700
// controls that pan or scroll sideways on their own keep the gesture, and so
// do a dialog (it renders inside <main>, and a sheet has its own pull) and a
// row's reorder grip
const NO_PULL = 'input, textarea, select, [contenteditable], [data-no-pull], dialog, [data-reorder-handle]'

/**
 * What a phone page does while it scrolls (below lg <main> is the scroller):
 * the large title docks into the app bar, the bar's hairline shows how far
 * down the page is, and from a screen down a button leads back to the top,
 * its ring showing the same progress. Rendered inside <main>, so it remounts
 * with each route. Nothing of it runs on a desktop, where the document scrolls
 * and the page header simply stays at the top.
 */
export default function PageScroll({ stacked }: { stacked: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const wide = useMediaQuery(WIDE_MQ)
  const button = useRef<HTMLButtonElement>(null)
  const ring = useRef<SVGCircleElement>(null)
  const pullMark = useRef<HTMLDivElement>(null)
  const pullText = useRef<HTMLSpanElement>(null)

  // Pull to refresh, on a top-level page and with a finger: at the top of the
  // page a pull down brings the page and a spinner with it, and letting go past
  // the mark reloads what the page shows. The data polls anyway; this is the
  // gesture a phone reader reaches for when they want it now. Native and
  // non-passive, as in the sheet: preventDefault on the first move is the only
  // way to keep the browser's own overscroll out of it.
  useEffect(() => {
    const main = button.current?.closest('main')
    const mark = pullMark.current
    if (wide || stacked || !main || !mark) return
    const say = (key: string) => {
      if (pullText.current) pullText.current.textContent = t(key)
    }
    let y0 = 0
    let x0 = 0
    let mode: 'none' | 'pull' | 'off' = 'off'
    let busy = false
    let armed = false
    const page = () => main.firstElementChild as HTMLElement | null
    // the page and the mark above it come down together; the mark turns
    // with the pull and fades in on the way
    const show = (d: number) => {
      const p = page()
      if (p) p.style.transform = d > 0 ? `translateY(${d}px)` : ''
      mark.style.top = `${main.offsetTop}px`
      mark.style.setProperty('--d', `${d}px`)
      mark.style.setProperty('--pull', String(clamp(d / PULL_AT)))
    }
    const glide = (on: boolean) => {
      const v = on ? 'transform var(--dur-2) var(--ease-out)' : 'none'
      const p = page()
      if (p) p.style.transition = v
      mark.style.transition = on
        ? 'translate var(--dur-2) var(--ease-out), opacity var(--dur-2) var(--ease-out)'
        : 'none'
    }
    const settle = () => {
      glide(true)
      show(0)
      // never leave a transform behind: it would trap position:fixed children
      setTimeout(() => {
        const p = page()
        if (p) p.style.transition = ''
        mark.style.transition = ''
        delete mark.dataset.state
      }, 250)
    }
    const onStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement | null
      mode = 'off'
      // any top-level page, with or without a large title: on Files it is how
      // a folder is listed again
      if (busy || e.touches.length !== 1 || main.scrollTop > 0) return
      // a page that scrolls a box of its own (Files' list) keeps the pull
      // for that box until it too is at its top
      for (let n = target; n && n !== main; n = n.parentElement) {
        if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight + 1) return
      }
      if (target?.closest(NO_PULL)) return
      mode = 'none'
      y0 = e.touches[0].clientY
      x0 = e.touches[0].clientX
      armed = false
    }
    const onMove = (e: TouchEvent) => {
      if (mode === 'off') return
      const dy = e.touches[0].clientY - y0
      const dx = e.touches[0].clientX - x0
      if (mode === 'none') {
        if (Math.abs(dy) < 4 && Math.abs(dx) < 4) return
        // sideways is the page swipe's, upwards is a normal scroll
        if (Math.abs(dx) > Math.abs(dy) || dy < 0 || main.scrollTop > 0) {
          mode = 'off'
          return
        }
        mode = 'pull'
        glide(false)
        mark.dataset.state = 'pull'
        say('app.pullHint')
      }
      if (e.cancelable) e.preventDefault()
      const d = Math.min(PULL_MAX, Math.max(0, dy) / 2)
      show(d)
      if (d >= PULL_AT !== armed) {
        armed = d >= PULL_AT
        mark.dataset.state = armed ? 'armed' : 'pull'
        say(armed ? 'app.pullRelease' : 'app.pullHint')
        if (armed) haptic(8)
      }
    }
    const onEnd = async () => {
      if (mode !== 'pull') return
      mode = 'off'
      if (!armed) return settle()
      busy = true
      // the page settles to the mark's height and stays there while it loads
      glide(true)
      show(PULL_AT)
      mark.dataset.state = 'busy'
      say('app.refreshing')
      const t0 = performance.now()
      await qc.refetchQueries({ type: 'active' }).catch(() => {})
      await new Promise((r) => setTimeout(r, Math.max(0, PULL_MIN_MS - (performance.now() - t0))))
      mark.dataset.state = 'done'
      say('app.refreshed')
      await new Promise((r) => setTimeout(r, DONE_MS))
      busy = false
      settle()
    }
    main.addEventListener('touchstart', onStart, { passive: true })
    main.addEventListener('touchmove', onMove, { passive: false })
    main.addEventListener('touchend', onEnd, { passive: true })
    // a cancelled touch never refreshes, however far it had come
    const onCancel = () => {
      if (mode !== 'pull') return
      mode = 'off'
      settle()
    }
    main.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      main.removeEventListener('touchstart', onStart)
      main.removeEventListener('touchmove', onMove)
      main.removeEventListener('touchend', onEnd)
      main.removeEventListener('touchcancel', onCancel)
      const p = page()
      if (p) p.style.transform = ''
    }
  }, [wide, stacked, qc, t])

  // a layout effect: the attributes have to be on the shell before the first
  // paint, or a stacked screen flashes its large title and a top-level one
  // its app bar title
  useLayoutEffect(() => {
    const main = button.current?.closest('main')
    const shell = main?.closest<HTMLElement>('.app-shell')
    if (!main || !shell) return
    shell.toggleAttribute('data-stacked', stacked)
    if (wide) return () => shell.removeAttribute('data-stacked')
    const line = shell.querySelector<HTMLElement>('.t-scroll-line')
    let frame = 0
    const update = () => {
      frame = 0
      // looked up every time: a page may render its header once its data is in
      const header = stacked ? null : main.querySelector<HTMLElement>('.t-page-header')
      const top = main.scrollTop
      const room = main.scrollHeight - main.clientHeight
      shell.toggleAttribute('data-large', !!header)
      header?.style.setProperty('--dock', clamp(top / DOCK_PX).toFixed(3))
      shell.toggleAttribute('data-docked', !header || top >= DOCK_PX * 0.75)
      // only a page that is really longer than the screen gets the progress
      const long = room > main.clientHeight * 0.5
      const p = long ? clamp(top / room) : 0
      if (line) line.style.transform = `scaleX(${p})`
      button.current?.toggleAttribute('data-show', long && top > main.clientHeight)
      ring.current?.style.setProperty('stroke-dashoffset', String(RING * (1 - p)))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    main.addEventListener('scroll', schedule, { passive: true })
    // a list that arrives after the first paint makes the page long
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : undefined
    if (main.firstElementChild) ro?.observe(main.firstElementChild)
    update()
    return () => {
      cancelAnimationFrame(frame)
      main.removeEventListener('scroll', schedule)
      ro?.disconnect()
      shell.removeAttribute('data-stacked')
      shell.removeAttribute('data-large')
      shell.removeAttribute('data-docked')
      if (line) line.style.transform = ''
    }
  }, [stacked, wide])

  const toTop = () => {
    const main = button.current?.closest('main')
    const still =
      document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches
    main?.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' })
  }

  return (
    <>
      {/* outside the sticky wrapper below: a sticky box is a containing block,
          and the mark drew itself at the bottom edge of the page */}
      <div ref={pullMark} className="t-pull" role="status" aria-live="polite">
        <RefreshCw aria-hidden size="1.1em" className="t-pull-spin" />
        <Check aria-hidden size="1.1em" className="t-pull-done" />
        <span ref={pullText} />
      </div>
      <div className="t-totop-wrap">
        <button ref={button} type="button" className="t-totop" aria-label={t('app.toTop')} onClick={toTop}>
          <svg className="t-totop-ring" viewBox="0 0 44 44" aria-hidden>
            <circle ref={ring} cx="22" cy="22" r="20" strokeDasharray={RING} strokeDashoffset={RING} />
          </svg>
          <ArrowUp aria-hidden size="1.1em" />
        </button>
      </div>
    </>
  )
}
