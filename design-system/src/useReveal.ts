import { useEffect, type RefObject } from 'react'

/** Where `.t-reveal`/`.t-ep` are tied to the scroll; the stylesheet gates its
 *  view-timeline rules on the same query. A finger drags the content, so an
 *  entrance scrubbed by the scroll lags behind it; touch gets the one-shot
 *  entrance instead. */
const SCROLL_REVEAL_MQ = '(hover: hover) and (pointer: fine)'

/**
 * Scroll reveal for touch screens and engines without view timelines
 * (Firefox). The stylesheet ties `.t-reveal` (and `.t-ep`) to the scroll for a
 * mouse where `animation-timeline: view()` exists; elsewhere this marks each
 * matching child `data-in="0"` and flips it to "1" once it enters the
 * viewport, and the mark's transition runs instead. Items already on screen
 * at mount are marked "1" straight away, so the first screen never fades in.
 * Items that enter together stagger by their place in that batch (`--i`).
 * Pass a key that changes when the list does.
 *
 *   const box = useRef<HTMLUListElement>(null)
 *   useReveal(box, '.t-reveal', items.length)
 */
export function useReveal(box: RefObject<HTMLElement | null>, selector: string, key: unknown) {
  useEffect(() => {
    const el = box.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    if (CSS.supports?.('animation-timeline: view()') && matchMedia(SCROLL_REVEAL_MQ).matches) return
    // "0" too: a key change disconnects the last observer, and an item it
    // still waited for would otherwise stay hidden for good
    const items = [...el.querySelectorAll<HTMLElement>(selector)].filter((i) => i.dataset.in !== '1')
    if (!items.length) return
    const io = new IntersectionObserver((seen) => {
      let k = 0
      for (const s of seen) {
        if (!s.isIntersecting) continue
        const i = s.target as HTMLElement
        i.style.setProperty('--i', String(k++))
        i.dataset.in = '1'
        io.unobserve(i)
      }
    })
    const h = innerHeight
    for (const i of items) {
      if (i.dataset.in === '0') {
        io.observe(i)
        continue
      }
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
