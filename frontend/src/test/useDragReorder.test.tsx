import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useDragReorder } from '../hooks/useDragReorder'

function List({ ids, onMove }: { ids: number[]; onMove: (id: number, to: number, dragged: boolean) => void }) {
  const list = useRef<HTMLUListElement>(null)
  const handle = useDragReorder({ list, ids, onMove })
  return (
    <ul ref={list}>
      {ids.map((id) => (
        <li key={id} data-reorder-id={id}>
          <button type="button" aria-label={`move ${id}`} {...handle(id)} />
        </li>
      ))}
    </ul>
  )
}

describe('useDragReorder', () => {
  // the keyboard is the reorder's non-drag way (WCAG 2.5.7)
  it('moves a row with the arrow keys, Home and End', () => {
    const onMove = vi.fn()
    render(<List ids={[1, 2, 3]} onMove={onMove} />)
    fireEvent.keyDown(screen.getByLabelText('move 2'), { key: 'ArrowUp' })
    expect(onMove).toHaveBeenLastCalledWith(2, 0, false)
    fireEvent.keyDown(screen.getByLabelText('move 2'), { key: 'End' })
    expect(onMove).toHaveBeenLastCalledWith(2, 2, false)
    fireEvent.keyDown(screen.getByLabelText('move 3'), { key: 'Home' })
    expect(onMove).toHaveBeenLastCalledWith(3, 0, false)
  })

  it('does nothing past either end', () => {
    const onMove = vi.fn()
    render(<List ids={[1, 2]} onMove={onMove} />)
    fireEvent.keyDown(screen.getByLabelText('move 1'), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByLabelText('move 2'), { key: 'ArrowDown' })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('keeps the page from scrolling under a finger on the handle', () => {
    render(<List ids={[1, 2]} onMove={vi.fn()} />)
    expect(screen.getByLabelText('move 1').style.touchAction).toBe('none')
  })
})
