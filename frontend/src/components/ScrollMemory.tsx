import { useEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router'

// Below lg the shell's <main> is the scroller and it is remounted on every
// route, so the browser restores nothing: back from a folder or a settings
// section landed at the top. The position is recorded per history entry while
// the user scrolls and put back on a POP navigation, once the new page has had
// a frame to lay out its rows (a second frame for a list that arrives late).
const KEY = 'weebsync.scroll.'

export default function ScrollMemory() {
  const { key, hash } = useLocation()
  const navType = useNavigationType()
  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.app-shell > main')
    const read = () => Math.max(main?.scrollTop ?? 0, window.scrollY)
    const write = (y: number) => {
      if (main) main.scrollTop = y
      window.scrollTo(0, y)
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
        if (el && el.getBoundingClientRect().height > 0) el.scrollIntoView()
        else if (tries > 0) pending = setTimeout(() => target(tries - 1), 100)
      }
      target(20)
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
  }, [key, hash, navType])
  return null
}
