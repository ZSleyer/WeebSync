import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SwipeRow } from '@weebsync/design-system'

// jsdom lays nothing out: the commit distance is the 60px floor
const swipe = (el: HTMLElement, dx: number) => {
  fireEvent.pointerDown(el, { clientX: 200, clientY: 100, pointerId: 1, button: 0, pointerType: 'touch' })
  fireEvent.pointerMove(el, { clientX: 200 + dx / 4, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 200 + dx, clientY: 100, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: 200 + dx, clientY: 100, pointerId: 1 })
}

describe('SwipeRow', () => {
  it('runs the action under the side the row was swiped past the mark', () => {
    const start = vi.fn()
    const end = vi.fn()
    render(
      <SwipeRow start={{ label: 'Nach vorn', run: start }} end={{ label: 'Abbrechen', leaves: true, run: end }}>
        <span>Zeile</span>
      </SwipeRow>,
    )
    const row = screen.getByText('Zeile')
    swipe(row, -30)
    expect(end).not.toHaveBeenCalled()
    swipe(row, -120)
    expect(end).toHaveBeenCalledTimes(1)
    swipe(row, 120)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('names the actions only visually - the row keeps its own buttons', () => {
    const { container } = render(
      <SwipeRow end={{ label: 'Abbrechen', run: vi.fn() }}>
        <span>Zeile</span>
      </SwipeRow>,
    )
    expect(container.querySelector('.t-swiperow__ground')).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('.t-swiperow__ground--start')).toBeNull()
  })

  it('ignores a mouse, which selects text on a row', () => {
    const end = vi.fn()
    render(
      <SwipeRow end={{ label: 'Abbrechen', run: end }}>
        <span>Zeile</span>
      </SwipeRow>,
    )
    const row = screen.getByText('Zeile')
    fireEvent.pointerDown(row, { clientX: 200, clientY: 100, pointerId: 2, button: 0, pointerType: 'mouse' })
    fireEvent.pointerMove(row, { clientX: 150, clientY: 100, pointerId: 2 })
    fireEvent.pointerMove(row, { clientX: 60, clientY: 100, pointerId: 2 })
    fireEvent.pointerUp(row, { clientX: 60, clientY: 100, pointerId: 2 })
    expect(end).not.toHaveBeenCalled()
  })
})
