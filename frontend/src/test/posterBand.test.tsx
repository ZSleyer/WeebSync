import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PosterBand } from '@weebsync/design-system'

const items = ['A', 'B', 'C'].map((k) => ({ key: k, chip: `Fr ${k}`, label: `Serie ${k}` }))

describe('PosterBand', () => {
  it('brings a side poster to the middle and opens the middle one', () => {
    const onIndex = vi.fn()
    const onOpen = vi.fn()
    render(<PosterBand items={items} index={1} onIndex={onIndex} onOpen={onOpen} label="Poster" />)
    expect(screen.getByLabelText('Serie B')).toHaveAttribute('aria-current', 'true')
    fireEvent.click(screen.getByLabelText('Serie C'))
    expect(onIndex).toHaveBeenLastCalledWith(2)
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Serie B'))
    expect(onOpen).toHaveBeenCalledWith(1)
  })

  it('steps with the arrow keys and stops at the ends', () => {
    const onIndex = vi.fn()
    render(<PosterBand items={items} index={0} onIndex={onIndex} onOpen={vi.fn()} label="Poster" />)
    const band = screen.getByRole('group', { name: 'Poster' })
    fireEvent.keyDown(band, { key: 'ArrowLeft' })
    expect(onIndex).not.toHaveBeenCalled()
    fireEvent.keyDown(band, { key: 'ArrowRight' })
    expect(onIndex).toHaveBeenLastCalledWith(1)
    fireEvent.keyDown(band, { key: 'End' })
    expect(onIndex).toHaveBeenLastCalledWith(2)
  })

  // the band is the only tab stop, so the keyboard opens the middle poster
  it('opens the middle poster with Enter', () => {
    const onOpen = vi.fn()
    render(<PosterBand items={items} index={1} onIndex={vi.fn()} onOpen={onOpen} label="Poster" />)
    fireEvent.keyDown(screen.getByRole('group', { name: 'Poster' }), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(1)
  })
})
