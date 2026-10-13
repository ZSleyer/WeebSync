import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CatalogTile, catalogFacts, coverStatusOf, vtName } from '../components/CatalogTile'
import type { Media } from '../api'

const media = (over: Partial<Media> = {}): Media =>
  ({
    id: 1,
    title: { romaji: 'Lycoris Recoil', english: '' },
    coverImage: { large: '' },
    seasonYear: 2022,
    format: 'TV',
    episodes: 13,
    averageScore: 82,
    status: 'FINISHED',
    nextAiringEpisode: null,
    studios: ['A-1 Pictures'],
    ...over,
  }) as Media

describe('catalog tile helpers', () => {
  it('maps provider states to cover chips', () => {
    expect(coverStatusOf('RELEASING')).toBe('live')
    expect(coverStatusOf('NOT_YET_RELEASED')).toBe('soon')
    expect(coverStatusOf('HIATUS')).toBe('paused')
    expect(coverStatusOf('CANCELLED')).toBe('done')
    expect(coverStatusOf('')).toBeUndefined()
  })

  it('writes the facts line and leaves out what is unknown', () => {
    const fmt = (f: string) => (f === 'TV' ? 'TV' : f)
    const eps = (n: number) => `${n} F.`
    expect(catalogFacts(media(), fmt, eps)).toBe('2022 · TV · 13 F.')
    expect(catalogFacts(media({ seasonYear: 0, episodes: 0 }), fmt, eps)).toBe('TV')
  })

  it('names tiles with a valid, stable ident', () => {
    const a = vtName('anilist:143270')
    expect(a).toMatch(/^cat-[0-9a-z]+$/)
    expect(vtName('anilist:143270')).toBe(a)
    expect(vtName('/Anime/2026-4 Fall/X')).not.toBe(a)
  })
})

describe('CatalogTile', () => {
  it('shows the title, the facts and says the share on disk in text', () => {
    render(<CatalogTile media={media()} name="Lycoris Recoil" have={5} onOpen={() => {}} />)
    const tile = screen.getByRole('button')
    expect(tile.textContent).toContain('Lycoris Recoil')
    expect(tile.textContent).toContain('2022')
    expect(tile.querySelector('.t-cover-bar')).not.toBeNull()
    expect(tile.querySelector('.t-cover-status')?.getAttribute('data-status')).toBe('done')
    expect(tile.querySelector('.ws-cat-peek')?.textContent).toContain('A-1 Pictures')
  })

  it('draws no bar without episodes on disk', () => {
    render(<CatalogTile media={media()} name="Lycoris Recoil" onOpen={() => {}} />)
    expect(screen.getByRole('button').querySelector('.t-cover-bar')).toBeNull()
  })
})
