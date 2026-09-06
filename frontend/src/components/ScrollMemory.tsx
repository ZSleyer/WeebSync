import { useEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router'

// Below lg the shell's <main> is the scroller and it is remounted on every
// route, so the browser restores nothing: back from a folder or a settings
// section landed at the top. The position is recorded per history entry while
// the user scrolls and put back on a POP navigation, once the new page has had
// a frame to lay out its rows (a second frame for a list that arrives late).
const KEY = 'weebsync.scroll.'

export default function ScrollMemory() {
  const { key } = useLocation()
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
    if (navType === 'POP') {
      const y = Number(sessionStorage.getItem(KEY + key) ?? 0)
      if (y > 0)
        requestAnimationFrame(() => {
          write(y)
          requestAnimationFrame(() => read() !== y && write(y))
        })
    }
    return () => {
      main?.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
      try {
        sessionStorage.setItem(KEY + key, String(last))
      } catch {
        /* storage blocked: the position is a convenience */
      }
    }
  }, [key, navType])
  return null
}
