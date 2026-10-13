import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Art, CoverBar, CoverScore, coverHue, coverShare, CoverStatus } from 'fluid-lycoris'

describe('coverHue', () => {
  it('is stable and inside the colour wheel', () => {
    expect(coverHue('One Piece')).toBe(coverHue('One Piece'))
    for (const t of ['', 'a', 'Re:Zero', 'x'.repeat(500)]) {
      const h = coverHue(t)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
    }
  })
})

describe('coverShare', () => {
  it('clamps to 0..1 and reads missing counts as nothing', () => {
    expect(coverShare(6, 12)).toBe(0.5)
    expect(coverShare(14, 12)).toBe(1)
    expect(coverShare(3, 0)).toBe(0)
    expect(coverShare(Number.NaN, 12)).toBe(0)
  })
})

describe('Art', () => {
  it('keeps picture and dots in one layer', () => {
    const { container } = render(<Art src="/b.jpg" dots dotsFrom="to left" />)
    const layer = container.firstElementChild as HTMLElement
    expect(layer).toHaveClass('t-art')
    expect(layer.querySelector('img')).toHaveAttribute('src', '/b.jpg')
    expect(layer.querySelector('.t-art-dots')).not.toBeNull()
    expect(layer.style.getPropertyValue('--tone-dir')).toBe('to left')
  })

  it('marks a duotone layer with its half of the colour code', () => {
    const { container } = render(<Art src="/b.jpg" duo="accent-2" />)
    expect(container.firstElementChild).toHaveAttribute('data-duo', 'accent-2')
  })
})

describe('cover chips', () => {
  it('marks the status and names the score', () => {
    render(
      <>
        <CoverStatus status="live">Läuft</CoverStatus>
        <CoverScore value="8.4" label="Bewertung" />
      </>,
    )
    expect(screen.getByText('Läuft')).toHaveAttribute('data-status', 'live')
    expect(screen.getByText('8.4', { exact: false })).toHaveTextContent('Bewertung 8.4')
  })

  it('draws the bar at its share', () => {
    const { container } = render(<CoverBar value={0.25} />)
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--p')).toBe('0.25')
  })
})
