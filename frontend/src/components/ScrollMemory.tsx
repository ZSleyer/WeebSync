import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { WIDE_MQ } from './PageActions'
import { topPage } from './RouteTransition'

// Below lg the shell's <main> is the scroller and it is remounted on every
// top-level page, so the browser restores nothing: back from a folder or a settings
// section landed at the top. The position is recorded per history entry while
// the user scrolls and put back on a POP navigation, once the new page has had
// a frame to lay out its rows (a second frame for a list that arrives late).
const KEY = 'weebsync.scroll.'

// where the window stands, noted as it scrolls: reading scrollY on demand
// would force a layout of a page that is being mounted
let winY = 0
if (typeof window !== 'undefined') window.addEventListener('scroll', () => (winY = window.scrollY), { passive: true })

export default function ScrollMemory() {
  const { key, hash, pathname } = useLocation()
  const navType = useNavigationType()
  // <main> stays mounted across the sections of one page, so a new section
  // has to be put to the top by hand; a changed query (a filter) keeps its place
  const lastPath = useRef(pathname)
  // before paint: a new screen must not show at the old position for a frame
  // and then jump while it animates in
  useLayoutEffect(() => {
    const prevPath = lastPath.current
    const newPath = prevPath !== pathname
    lastPath.current = pathname
    const main = document.querySelector<HTMLElement>('.app-shell > main')
    // On a phone <main> is the only scroller. The document may still be a few
    // pixels taller than the screen (iOS toolbars, safe areas); moving it as
    // well slid the shell, and with it the top bar, out of view.
    const phone = !window.matchMedia(WIDE_MQ).matches
    const read = () => (phone ? (main?.scrollTop ?? 0) : Math.max(main?.scrollTop ?? 0, window.scrollY))
    const write = (y: number) => {
      if (main) main.scrollTop = y
      if (!phone) window.scrollTo(0, y)
    }
    let last = 0
    const onScroll = () => (last = read())
    main?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    const saved = navType === 'POP' ? Number(sessionStorage.getItem(KEY + key) ?? 0) : 0
    let pending: ReturnType<typeof setTimeout> | undefined
    if (saved > 0) {
      requestAnimationFrame(() => {
        write(saved)
        requestAnimationFrame(() => read() !== saved && write(saved))
      })
    } else if (hash) {
      // a section of a merged page (#users, #email, #import): the router does
      // not scroll to it, and the section may not have rendered yet - a form
      // seeds from a request first - so keep trying for a moment
      const target = (tries: number) => {
        const el = document.getElementById(hash.slice(1))
        if (el && el.getBoundingClientRect().height > 0) {
          if (phone && main) main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top
          else el.scrollIntoView()
        } else if (tries > 0) pending = setTimeout(() => target(tries - 1), 100)
      }
      target(20)
    } else if (newPath) {
      // Another top-level page remounts <main> (keyed by it), which then
      // starts at the top: writing scrollTop there only forced a layout of
      // the page being mounted. The window scrolls only on a desktop, and
      // only when it has been scrolled.
      if (main && topPage(prevPath) === topPage(pathname)) main.scrollTop = 0
      if (!phone && winY > 0) window.scrollTo(0, 0)
    }
    return () => {
      clearTimeout(pending)
      main?.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
      try {
        sessionStorage.setItem(KEY + key, String(last))
      } catch {
        /* storage blocked: the position is a convenience */
      }
    }
  }, [key, hash, navType, pathname])
  return null
}
