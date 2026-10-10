import { useEffect, type RefObject } from 'react'

/**
 * Scroll reveal for engines without view timelines (Firefox). The stylesheet
 * ties `.t-reveal` (and `.t-ep`) to the scroll where `animation-timeline:
 * view()` exists; elsewhere this marks each matching child `data-in="0"` and
 * flips it to "1" once it enters the viewport, and the mark's transition runs
 * instead. Items already on screen at mount are marked "1" straight away, so
 * the first screen never fades in. Pass a key that changes when the list does.
 *
 *   const box = useRef<HTMLUListElement>(null)
 *   useReveal(box, '.t-reveal', items.length)
 */
export function useReveal(box: RefObject<HTMLElement | null>, selector: string, key: unknown) {
  useEffect(() => {
    const el = box.current
    if (!el || typeof IntersectionObserver === 'undefined' || CSS.supports?.('animation-timeline: view()')) return
    const items = [...el.querySelectorAll<HTMLElement>(selector)].filter((i) => !i.dataset.in)
    if (!items.length) return
    const io = new IntersectionObserver((seen) => {
      for (const s of seen) {
        if (!s.isIntersecting) continue
        const i = s.target as HTMLElement
        i.dataset.in = '1'
        io.unobserve(i)
      }
    })
    const h = innerHeight
    for (const i of items) {
      const r = i.getBoundingClientRect()
      // on screen already: no entrance, the content is simply there
      if (r.top < h && r.bottom > 0) i.dataset.in = '1'
      else {
        i.dataset.in = '0'
        io.observe(i)
      }
    }
    return () => io.disconnect()
  }, [box, selector, key])
}
