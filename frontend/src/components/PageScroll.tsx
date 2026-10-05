import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp } from 'lucide-react'
import { useMediaQuery } from '@weebsync/design-system'
import { WIDE_MQ } from './PageActions'

// How far a phone page has to scroll before the large title has gone and the
// app bar's title takes over: about the title's own height.
const DOCK_PX = 56
// the ring's circumference at r = 20 in a 44 box
const RING = 2 * Math.PI * 20

const clamp = (v: number) => Math.min(1, Math.max(0, v))

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
  const wide = useMediaQuery(WIDE_MQ)
  const button = useRef<HTMLButtonElement>(null)
  const ring = useRef<SVGCircleElement>(null)

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
    <div className="t-totop-wrap">
      <button ref={button} type="button" className="t-totop" aria-label={t('app.toTop')} onClick={toTop}>
        <svg className="t-totop-ring" viewBox="0 0 44 44" aria-hidden>
          <circle ref={ring} cx="22" cy="22" r="20" strokeDasharray={RING} strokeDashoffset={RING} />
        </svg>
        <ArrowUp aria-hidden size="1.1em" />
      </button>
    </div>
  )
}
