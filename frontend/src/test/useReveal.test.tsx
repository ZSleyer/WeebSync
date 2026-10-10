import { useRef } from 'react'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useReveal } from '@weebsync/design-system'

function List() {
  const box = useRef<HTMLUListElement>(null)
  useReveal(box, '.t-reveal', 2)
  return (
    <ul ref={box}>
      <li className="t-reveal">on screen</li>
      <li className="t-reveal">below</li>
    </ul>
  )
}

describe('useReveal', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('marks what is on screen as in, observes the rest, and lets it in on entry', () => {
    // jsdom answers every CSS.supports with yes; this is the Firefox path
    vi.stubGlobal('CSS', { supports: () => false })
    let fire: (e: Partial<IntersectionObserverEntry>[]) => void = () => {}
    const observed: Element[] = []
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
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const below = this.textContent === 'below'
      return { top: below ? 2000 : 10, bottom: below ? 2040 : 50 } as DOMRect
    }
    try {
      const { getByText } = render(<List />)
      expect(getByText('on screen').dataset.in).toBe('1')
      const below = getByText('below')
      expect(below.dataset.in).toBe('0')
      expect(observed).toEqual([below])
      fire([{ isIntersecting: true, target: below }])
      expect(below.dataset.in).toBe('1')
    } finally {
      Element.prototype.getBoundingClientRect = rect
    }
  })
})
