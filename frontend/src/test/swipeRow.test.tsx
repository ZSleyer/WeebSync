import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SwipeRow } from '@weebsync/design-system'

// jsdom lays nothing out: the buttons measure 0 wide, so any swipe past the
// slop towards a side with buttons opens the row on them
const swipe = (el: HTMLElement, dx: number, pointerType = 'touch') => {
  fireEvent.pointerDown(el, { clientX: 200, clientY: 100, pointerId: 1, button: 0, pointerType })
  fireEvent.pointerMove(el, { clientX: 200 + dx / 4, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 200 + dx, clientY: 100, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: 200 + dx, clientY: 100, pointerId: 1 })
}

const row = (run = vi.fn(), onRowClick = vi.fn()) => {
  render(
    <SwipeRow end={[{ key: 'cancel', label: 'Abbrechen', run }]}>
      <button type="button" onClick={onRowClick}>
        Zeile
      </button>
    </SwipeRow>,
  )
  return { run, onRowClick, ground: screen.getByText('Abbrechen').closest('.t-swiperow__ground') as HTMLElement }
}

describe('SwipeRow', () => {
  // the swipe only uncovers; the tap on the button is what runs it
  it('opens on its buttons and runs one only when it is tapped', () => {
    const { run, ground } = row()
    expect(ground).toHaveAttribute('inert')
    swipe(screen.getByText('Zeile'), -120)
    expect(ground).not.toHaveAttribute('inert')
    expect(run).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Abbrechen'))
    expect(run).toHaveBeenCalledTimes(1)
    expect(ground).toHaveAttribute('inert')
  })

  it('closes on a tap elsewhere, and a tap on the row only closes it', () => {
    const { onRowClick, ground } = row()
    const face = screen.getByText('Zeile')
    swipe(face, -120)
    fireEvent.pointerDown(document.body)
    expect(ground).toHaveAttribute('inert')
    swipe(face, -120)
    fireEvent.pointerDown(face)
    fireEvent.click(face)
    expect(onRowClick).not.toHaveBeenCalled()
    expect(ground).toHaveAttribute('inert')
  })

  it('does not open towards a side without buttons', () => {
    const { ground } = row()
    swipe(screen.getByText('Zeile'), 120)
    expect(ground).toHaveAttribute('inert')
  })

  it('ignores a mouse, which selects text on a row', () => {
    const { ground } = row()
    swipe(screen.getByText('Zeile'), -120, 'mouse')
    expect(ground).toHaveAttribute('inert')
  })
})
