import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import SourceLine from '../components/SourceLine'
import MediaDetail from '../components/MediaDetail'
import type { Media } from '../api'

const media = { id: 7, title: { romaji: 'Demo' }, episodes: 12 } as Media
const rows = (c: HTMLElement) => [...c.querySelectorAll('.ws-d-src li')].map((li) => li.textContent)

describe('SourceLine', () => {
  it('links the provider behind the page and shows its mark', () => {
    const { container } = render(<SourceLine primary={{ label: 'TVDB', href: 'https://thetvdb.com/x' }} />)
    const a = container.querySelector('.ws-d-src a') as HTMLAnchorElement
    expect(a.href).toBe('https://thetvdb.com/x')
    expect(a.querySelector('img')?.getAttribute('alt')).toBe('TVDB')
    expect(rows(container)).toHaveLength(1)
  })

  it('adds dub dates and the numbering provider only when in use', () => {
    const { container } = render(
      <SourceLine primary={{ label: 'AniList', href: 'https://anilist.co/anime/7' }} dubDates mappedBy="tvdb" />,
    )
    expect(rows(container)).toHaveLength(3)
    expect(container.querySelector('img[alt="TVDB"]')).not.toBeNull()
    expect(rows(container).some((n) => n?.includes('Crunchyroll'))).toBe(true)
    // the same provider is not listed twice
    const same = render(<SourceLine primary={{ label: 'TVDB', href: 'https://t' }} mappedBy="tvdb" />)
    expect(rows(same.container)).toHaveLength(1)
  })

  it('closes the overview of a title', () => {
    const { container } = render(<MediaDetail media={media} source="tmdb:tv" now={0} />)
    expect(container.querySelector('.ws-d-src a')?.getAttribute('href')).toContain('themoviedb.org/tv/7')
  })
})
