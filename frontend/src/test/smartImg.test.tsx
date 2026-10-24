import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CoverImg } from '../components/SmartImg'

const set = { src: '/c.jpg', small: '/c-s.jpg' } as never

describe('CoverImg', () => {
  it('falls back to the title when the cover cannot be loaded', () => {
    const { container } = render(<CoverImg set={set} title="Frieren" sizes="100px" alt="Frieren" />)
    expect(container.querySelector('.t-cover--fallback')).toBeNull()
    fireEvent.error(screen.getByRole('img', { name: 'Frieren' }))
    expect(container.querySelector('.t-cover--fallback')).not.toBeNull()
    expect(screen.getByText('Frieren')).toBeInTheDocument()
  })

  it('keeps the cover when only the small preview fails', () => {
    const { container } = render(<CoverImg set={set} title="Frieren" sizes="100px" alt="Frieren" />)
    fireEvent.error(container.querySelector('img[aria-hidden]')!)
    expect(container.querySelector('.t-cover--fallback')).toBeNull()
  })

  it('falls back when the cover already failed before hydration (complete, no width)', () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    const width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0)
    try {
      const { container } = render(<CoverImg set={set} title="Frieren" sizes="100px" alt="Frieren" />)
      expect(container.querySelector('.t-cover--fallback')).not.toBeNull()
      expect(screen.getByText('Frieren')).toBeInTheDocument()
    } finally {
      complete.mockRestore()
      width.mockRestore()
    }
  })

  it('keeps a cover that is complete with a width', () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    const width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(300)
    try {
      const { container } = render(<CoverImg set={set} title="Frieren" sizes="100px" alt="Frieren" />)
      expect(container.querySelector('.t-cover--fallback')).toBeNull()
    } finally {
      complete.mockRestore()
      width.mockRestore()
    }
  })
})
