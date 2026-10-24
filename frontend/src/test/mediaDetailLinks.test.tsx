import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MediaDetail, { mediaLink } from '../components/MediaDetail'
import type { Media } from '../api'

const media = { id: 1, title: { romaji: 'Demo' }, episodes: 12 } as Media

const links = [
  {
    site: 'Crunchyroll',
    url: 'https://cr.example/a',
    type: 'STREAMING',
    icon: 'https://i.example/cr.png',
    color: '#f47521',
  },
  { site: 'Netflix', url: 'https://nf.example/a', type: 'STREAMING', color: '#e50914' },
  { site: 'Twitter', url: 'https://tw.example/a', type: 'SOCIAL' },
]

const view = () => render(<MediaDetail media={media} links={links} now={0} />)
const row = (c: HTMLElement, site: string) =>
  [...c.querySelectorAll('.ws-d-links a')].find((a) => a.textContent?.includes(site)) as HTMLElement

describe('MediaDetail outbound links', () => {
  it('shows the brand mark for a link with an icon', () => {
    const { container } = view()
    const mark = row(container, 'Crunchyroll').querySelector('.ws-d-mark') as HTMLElement
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(mark.style.getPropertyValue('--lc')).toBe('#f47521')
    expect(mark.querySelector('img')?.getAttribute('src')).toBe('https://i.example/cr.png')
    expect(row(container, 'Crunchyroll').querySelector('.ws-d-dot')).toBeNull()
  })

  it('keeps the dot and the external-link icon without an icon', () => {
    const { container } = view()
    expect(row(container, 'Netflix').querySelector('.ws-d-dot')).not.toBeNull()
    expect(row(container, 'Netflix').querySelector('img')).toBeNull()
    expect(row(container, 'Twitter').querySelector('svg')).not.toBeNull()
    expect(row(container, 'Twitter').querySelector('.ws-d-mark')).toBeNull()
  })

  it('falls back to the dot when the icon fails to load', () => {
    const { container } = view()
    fireEvent.error(row(container, 'Crunchyroll').querySelector('img')!)
    expect(row(container, 'Crunchyroll').querySelector('.ws-d-mark')).toBeNull()
    expect(row(container, 'Crunchyroll').querySelector('.ws-d-dot')).not.toBeNull()
  })

  it("gives the provider's own link its brand mark", () => {
    const { container } = view()
    const mark = row(container, 'AniList').querySelector('.ws-d-mark') as HTMLElement
    expect(mark.querySelector('img')).not.toBeNull()
    expect(mark.style.getPropertyValue('--lc')).toBe('#0b1622')
  })
})

describe('mediaLink', () => {
  it('points a manga at the manga page of AniList and everything else AniList at anime', () => {
    expect(mediaLink('anilist:manga', 5).href).toBe('https://anilist.co/manga/5')
    expect(mediaLink('anilist', 5).href).toBe('https://anilist.co/anime/5')
    expect(mediaLink(undefined, 5).href).toBe('https://anilist.co/anime/5')
  })
})
