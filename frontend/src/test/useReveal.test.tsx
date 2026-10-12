import { useRef } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReveal } from '@weebsync/design-system'

function List({ k = 2 }: { k?: number }) {
  const box = useRef<HTMLUListElement>(null)
  useReveal(box, '.t-reveal', k)
  return (
    <ul ref={box}>
      <li className="t-reveal">on screen</li>
      <li className="t-reveal">below</li>
    </ul>
  )
}

describe('useReveal', () => {
  let fire: (e: Partial<IntersectionObserverEntry>[]) => void
  let observed: Element[]
  const rect = Element.prototype.getBoundingClientRect

  beforeEach(() => {
    fire = () => {}
    observed = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: typeof fire) {
          fire = cb
        }
        observe(el: Element) {
          observed.push(el)
        }
        unobserve() {}
        disconnect() {}
      },
    )
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const below = this.textContent === 'below'
      return { top: below ? 2000 : 10, bottom: below ? 2040 : 50 } as DOMRect
    }
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    Element.prototype.getBoundingClientRect = rect
  })

  it('marks what is on screen as in, observes the rest, and lets it in on entry', () => {
    // jsdom answers every CSS.supports with yes; this is the Firefox path
    vi.stubGlobal('CSS', { supports: () => false })
    const { getByText } = render(<List />)
    expect(getByText('on screen').dataset.in).toBe('1')
    const below = getByText('below')
    expect(below.dataset.in).toBe('0')
    expect(observed).toEqual([below])
    fire([{ isIntersecting: true, target: below }])
    expect(below.dataset.in).toBe('1')
  })

  it('keeps watching an item still out when the key changes', () => {
    vi.stubGlobal('CSS', { supports: () => false })
    const { getByText, rerender } = render(<List k={1} />)
    const below = getByText('below')
    rerender(<List k={2} />)
    // the new observer has to take over the one the old one waited for
    expect(observed).toEqual([below, below])
    fire([{ isIntersecting: true, target: below }])
    expect(below.dataset.in).toBe('1')
  })

  it('reveals once on touch even where view timelines exist', () => {
    vi.stubGlobal('CSS', { supports: () => true })
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const { getByText } = render(<List />)
    expect(getByText('below').dataset.in).toBe('0')
  })

  it('leaves the scroll-tied animation alone for a mouse', () => {
    vi.stubGlobal('CSS', { supports: () => true })
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { getByText } = render(<List />)
    expect(getByText('below').dataset.in).toBeUndefined()
  })
})
