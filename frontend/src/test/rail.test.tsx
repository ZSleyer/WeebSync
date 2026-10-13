import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Rail, railEdges } from 'fluid-lycoris'

describe('railEdges', () => {
  it('reports more at the end only while at the start', () => {
    expect(railEdges(0, 300, 900)).toEqual({ start: false, end: true })
  })
  it('reports both in the middle', () => {
    expect(railEdges(300, 300, 900)).toEqual({ start: true, end: true })
  })
  it('reports the start only at the end, with a few pixels of slack', () => {
    expect(railEdges(598, 300, 900)).toEqual({ start: true, end: false })
  })
  it('reports nothing when everything fits', () => {
    expect(railEdges(0, 900, 900)).toEqual({ start: false, end: false })
  })
})

function sized(el: HTMLElement, clientWidth: number, scrollWidth: number) {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth })
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth })
}

describe('Rail', () => {
  it('shows the paging button and the fade on the side with more, and follows the scroll', () => {
    const { container } = render(
      <Rail prevLabel="Zurück" nextLabel="Weiter" aria-label="Neu da">
        <button type="button">A</button>
        <button type="button">B</button>
      </Rail>,
    )
    const rail = screen.getByRole('region', { name: 'Neu da' })
    const row = container.querySelector('.t-shelf') as HTMLElement
    sized(row, 300, 900)
    act(() => {
      fireEvent.scroll(row)
    })
    expect(rail).toHaveAttribute('data-more-end')
    expect(rail).not.toHaveAttribute('data-more-start')
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Zurück' })).toBeNull()

    row.scrollLeft = 600
    act(() => {
      fireEvent.scroll(row)
    })
    expect(rail).toHaveAttribute('data-more-start')
    expect(rail).not.toHaveAttribute('data-more-end')
  })

  it('pages by most of its width', () => {
    const { container } = render(
      <Rail prevLabel="Zurück" nextLabel="Weiter">
        <span>A</span>
      </Rail>,
    )
    const row = container.querySelector('.t-shelf') as HTMLElement
    sized(row, 500, 2000)
    const scrollBy = vi.fn()
    row.scrollBy = scrollBy as unknown as typeof row.scrollBy
    act(() => {
      fireEvent.scroll(row)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 400 }))
  })

  it('lets a still click through but eats the click that ends a mouse drag', () => {
    const open = vi.fn()
    const { container } = render(
      <Rail prevLabel="Zurück" nextLabel="Weiter">
        <button type="button" onClick={open}>
          A
        </button>
      </Rail>,
    )
    const row = container.querySelector('.t-shelf') as HTMLElement
    const a = screen.getByRole('button', { name: 'A' })

    fireEvent.pointerDown(row, { pointerType: 'mouse', button: 0, pointerId: 1, clientX: 100 })
    fireEvent.pointerUp(row, { pointerType: 'mouse', pointerId: 1, clientX: 102 })
    fireEvent.click(a)
    expect(open).toHaveBeenCalledTimes(1)

    fireEvent.pointerDown(row, { pointerType: 'mouse', button: 0, pointerId: 2, clientX: 100 })
    fireEvent.pointerMove(row, { pointerType: 'mouse', pointerId: 2, clientX: 40 })
    expect(row).toHaveClass('dragging')
    fireEvent.pointerUp(row, { pointerType: 'mouse', pointerId: 2, clientX: 40 })
    fireEvent.click(a)
    expect(open).toHaveBeenCalledTimes(1)
    expect(row).not.toHaveClass('dragging')
  })

  it('leaves touch to the browser', () => {
    const { container } = render(
      <Rail prevLabel="Zurück" nextLabel="Weiter">
        <span>A</span>
      </Rail>,
    )
    const row = container.querySelector('.t-shelf') as HTMLElement
    fireEvent.pointerDown(row, { pointerType: 'touch', button: 0, pointerId: 3, clientX: 100 })
    fireEvent.pointerMove(row, { pointerType: 'touch', pointerId: 3, clientX: 10 })
    expect(row).not.toHaveClass('dragging')
  })
})
