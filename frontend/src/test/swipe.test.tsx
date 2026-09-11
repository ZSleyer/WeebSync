import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSwipe, type SwipeOptions } from '@weebsync/design-system'

// jsdom reports clientWidth 0, so the commit distance is the 60px floor and a
// 100px drag pages while a 30px one settles back. Pointer capture is absent
// from jsdom entirely - the hook swallows that, which is what lets these tests
// run at all.

function Zone({ children, ...opts }: SwipeOptions & { children?: React.ReactNode }) {
  return (
    <div data-testid="zone" {...useSwipe(opts)}>
      {children ?? <span>Inhalt</span>}
    </div>
  )
}

/** A swipe: down, one move past the slop, one to the target, up. */
const swipe = (el: HTMLElement, dx: number, dy = 0, opts: Record<string, unknown> = {}) => {
  const from = el.ownerDocument.querySelector('[data-testid="zone"]') as HTMLElement
  fireEvent.pointerDown(el, { clientX: 100, clientY: 100, pointerId: 1, button: 0, pointerType: 'touch', ...opts })
  fireEvent.pointerMove(from, { clientX: 100 + dx / 4, clientY: 100 + dy / 4, pointerId: 1 })
  fireEvent.pointerMove(from, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 })
  fireEvent.pointerUp(from, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 })
}

describe('useSwipe', () => {
  it('pages forward on a swipe left and back on a swipe right', () => {
    const onNext = vi.fn()
    const onPrev = vi.fn()
    render(<Zone onNext={onNext} onPrev={onPrev} />)
    const zone = screen.getByTestId('zone')
    swipe(zone, -100)
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(onPrev).not.toHaveBeenCalled()
    swipe(zone, 100)
    expect(onPrev).toHaveBeenCalledTimes(1)
  })

  it('leaves no transform behind, so menus keep their containing block', () => {
    render(<Zone onNext={vi.fn()} />)
    const zone = screen.getByTestId('zone')
    swipe(zone, -100)
    expect(zone.style.transform).toBe('')
  })

  it('settles a short swipe back without paging', () => {
    const onNext = vi.fn()
    render(<Zone onNext={onNext} />)
    swipe(screen.getByTestId('zone'), -30)
    expect(onNext).not.toHaveBeenCalled()
  })

  it('gives a mostly vertical drag to the browser', () => {
    const onNext = vi.fn()
    render(<Zone onNext={onNext} />)
    swipe(screen.getByTestId('zone'), -100, -200)
    expect(onNext).not.toHaveBeenCalled()
  })

  it('only rubber-bands at an edge with no handler', () => {
    const onPrev = vi.fn()
    render(<Zone onPrev={onPrev} />)
    const zone = screen.getByTestId('zone')
    swipe(zone, -100)
    expect(onPrev).not.toHaveBeenCalled()
    expect(zone.style.transform).toBe('')
  })

  it('ignores a mouse drag unless the zone asked for one', () => {
    const onNext = vi.fn()
    const { rerender } = render(<Zone onNext={onNext} />)
    swipe(screen.getByTestId('zone'), -100, 0, { pointerType: 'mouse' })
    expect(onNext).not.toHaveBeenCalled()
    rerender(<Zone onNext={onNext} mouse />)
    swipe(screen.getByTestId('zone'), -100, 0, { pointerType: 'mouse' })
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('leaves the pointer to a horizontal scroller and to form controls', () => {
    const onNext = vi.fn()
    render(
      <Zone onNext={onNext}>
        <div data-testid="bar" style={{ overflowX: 'auto' }}>
          <button type="button">Tab</button>
        </div>
        <input aria-label="Feld" />
      </Zone>,
    )
    // jsdom lays nothing out, so the scroller's width is faked
    const bar = screen.getByTestId('bar')
    Object.defineProperty(bar, 'scrollWidth', { value: 400 })
    Object.defineProperty(bar, 'clientWidth', { value: 200 })
    swipe(screen.getByText('Tab'), -100)
    expect(onNext).not.toHaveBeenCalled()
    swipe(screen.getByLabelText('Feld'), -100)
    expect(onNext).not.toHaveBeenCalled()
    // the zone itself still swipes
    swipe(screen.getByTestId('zone'), -100)
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('gives a nested zone the gesture and stays put itself', () => {
    const outer = vi.fn()
    const inner = vi.fn()
    const Nested = () => (
      <div data-testid="outer" {...useSwipe({ onNext: outer })}>
        <div data-testid="zone" {...useSwipe({ onNext: inner })}>
          <span>Innen</span>
        </div>
      </div>
    )
    render(<Nested />)
    swipe(screen.getByText('Innen'), -100)
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
    expect(screen.getByTestId('outer').style.transform).toBe('')
  })

  it('blocks the native drag only where the swipe is live', () => {
    render(<Zone onNext={vi.fn()} mouse />)
    const zone = screen.getByTestId('zone')
    // nothing held: the browser keeps its own drag
    expect(fireEvent.dragStart(zone)).toBe(true)
    fireEvent.pointerDown(zone, { clientX: 100, clientY: 100, pointerId: 1, button: 0, pointerType: 'mouse' })
    expect(fireEvent.dragStart(zone)).toBe(false)
  })

  it('does nothing while disabled', () => {
    const onNext = vi.fn()
    render(<Zone onNext={onNext} disabled />)
    const zone = screen.getByTestId('zone')
    expect(zone.style.touchAction).toBe('')
    swipe(zone, -100)
    expect(onNext).not.toHaveBeenCalled()
  })
})
