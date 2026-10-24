import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
})
