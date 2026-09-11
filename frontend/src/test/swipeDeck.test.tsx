import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SwipeDeck } from '@weebsync/design-system'

// jsdom runs no transitions, so the landing is driven by a transitionEnd fired
// by hand here - in a browser the same event arrives on its own, and the deck's
// own timer is the net under it.

const deck = (props: { index?: number; onIndex?: (i: number) => void; canPrev?: boolean; step?: number }) =>
  render(
    <SwipeDeck index={props.index ?? 0} onIndex={props.onIndex ?? (() => {})} canPrev={props.canPrev} step={props.step} className="deck">
      {(i) => <p>Seite {i}</p>}
    </SwipeDeck>,
  )

const box = () => document.querySelector('.deck') as HTMLElement
const track = () => box().firstElementChild as HTMLElement

const drag = (dx: number, release = true) => {
  const el = box()
  fireEvent.pointerDown(el, { clientX: 300, clientY: 100, pointerId: 1, button: 0, pointerType: 'touch' })
  fireEvent.pointerMove(el, { clientX: 300 + dx / 4, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 300 + dx, clientY: 100, pointerId: 1 })
  if (release) fireEvent.pointerUp(el, { clientX: 300 + dx, clientY: 100, pointerId: 1 })
}

describe('SwipeDeck', () => {
  it('holds no transform and only its own page while it rests', () => {
    deck({ index: 3 })
    expect(screen.getByText('Seite 3')).toBeInTheDocument()
    expect(screen.queryByText('Seite 2')).toBeNull()
    expect(screen.queryByText('Seite 4')).toBeNull()
    expect(track().style.transform).toBe('')
  })

  it('brings both neighbours alongside while the finger is down', () => {
    deck({ index: 3 })
    drag(-80, false)
    expect(screen.getByText('Seite 2')).toBeInTheDocument()
    expect(screen.getByText('Seite 4')).toBeInTheDocument()
    expect(track().style.transform).toBe('translateX(-80px)')
  })

  it('turns the page once the slide has landed', () => {
    const onIndex = vi.fn()
    deck({ index: 3, onIndex })
    drag(-100)
    // still travelling: the page turns when the slide is over, not before
    expect(onIndex).not.toHaveBeenCalled()
    fireEvent.transitionEnd(track())
    expect(onIndex).toHaveBeenCalledWith(4)
  })

  it('springs home after a short swipe and leaves nothing behind', () => {
    const onIndex = vi.fn()
    deck({ index: 3, onIndex })
    drag(-20)
    fireEvent.transitionEnd(track())
    expect(onIndex).not.toHaveBeenCalled()
    expect(track().style.transform).toBe('')
    expect(screen.queryByText('Seite 2')).toBeNull()
  })

  it('pages by its step while the index counts in ones', () => {
    const onIndex = vi.fn()
    deck({ index: 3, onIndex, step: 7 })
    drag(-100, false)
    expect(screen.getByText('Seite -4')).toBeInTheDocument()
    expect(screen.getByText('Seite 10')).toBeInTheDocument()
    fireEvent.pointerUp(box(), { clientX: 200, clientY: 100, pointerId: 1 })
    fireEvent.transitionEnd(track())
    expect(onIndex).toHaveBeenCalledWith(10)
  })

  it('has no page and no neighbour behind a closed end', () => {
    const onIndex = vi.fn()
    deck({ index: 0, onIndex, canPrev: false })
    drag(120)
    expect(screen.queryByText('Seite -1')).toBeNull()
    expect(onIndex).not.toHaveBeenCalled()
  })
})
