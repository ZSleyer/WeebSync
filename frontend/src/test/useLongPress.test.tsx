import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLongPress } from '@weebsync/design-system'

function Item({ onLongPress, onClick }: { onLongPress?: () => void; onClick?: () => void }) {
  return (
    <div {...useLongPress(onLongPress)}>
      <button type="button" onClick={onClick}>
        Kachel
      </button>
    </div>
  )
}

describe('useLongPress', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opens the menu after a resting finger, and swallows the click that follows', () => {
    const onLongPress = vi.fn()
    const onClick = vi.fn()
    render(<Item onLongPress={onLongPress} onClick={onClick} />)
    const tile = screen.getByText('Kachel')
    fireEvent.pointerDown(tile, { pointerType: 'touch', clientX: 10, clientY: 10 })
    expect(tile.parentElement).toHaveAttribute('data-pressing')
    act(() => vi.advanceTimersByTime(450))
    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(tile.parentElement).not.toHaveAttribute('data-pressing')
    fireEvent.pointerUp(tile)
    fireEvent.click(tile)
    expect(onClick).not.toHaveBeenCalled()
    // the next, ordinary tap goes through
    fireEvent.pointerDown(tile, { pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerUp(tile)
    fireEvent.click(tile)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('lets a moving finger scroll instead', () => {
    const onLongPress = vi.fn()
    render(<Item onLongPress={onLongPress} />)
    const tile = screen.getByText('Kachel')
    fireEvent.pointerDown(tile, { pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerMove(tile, { clientX: 10, clientY: 30 })
    act(() => vi.advanceTimersByTime(600))
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('leaves a mouse its own context menu', () => {
    const onLongPress = vi.fn()
    render(<Item onLongPress={onLongPress} />)
    const tile = screen.getByText('Kachel')
    fireEvent.pointerDown(tile, { pointerType: 'mouse', clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(600))
    expect(onLongPress).not.toHaveBeenCalled()
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    tile.dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(false)
  })
})
