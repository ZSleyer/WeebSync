import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppBadge } from '../appBadge'
import { shareLink } from '../clipboard'
import { parseShare } from '../share'

const parse = (q: string) => parseShare(new URLSearchParams(q))

describe('parseShare', () => {
  it('opens an AniList title', () => {
    expect(parse('url=https://anilist.co/anime/1')).toEqual({ kind: 'title', path: '/title/anilist/1' })
    expect(parse('url=https://anilist.co/anime/154587/Frieren/')).toEqual({
      kind: 'title',
      path: '/title/anilist/154587',
    })
  })
  it('finds the link inside shared text', () => {
    expect(parse('text=Look at this https://anilist.co/anime/21 now')).toEqual({
      kind: 'title',
      path: '/title/anilist/21',
    })
  })
  it('opens TMDB and TVDB titles by id', () => {
    expect(parse('url=https://www.themoviedb.org/tv/1396-breaking-bad')).toEqual({
      kind: 'title',
      path: '/title/tmdb:tv/1396',
    })
    expect(parse('url=https://www.themoviedb.org/movie/603')).toEqual({ kind: 'title', path: '/title/tmdb:movie/603' })
    expect(parse('url=https://thetvdb.com/dereferrer/series/81189')).toEqual({
      kind: 'title',
      path: '/title/tvdb/81189',
    })
    expect(parse('url=https://thetvdb.com/dereferrer/movie/5')).toEqual({ kind: 'title', path: '/title/tvdb:movie/5' })
  })
  it('searches the name in a slugged TVDB or a MyAnimeList address', () => {
    expect(parse('url=https://thetvdb.com/series/one-piece')).toEqual({ kind: 'search', q: 'one piece' })
    expect(parse('url=https://myanimelist.net/anime/5114/Fullmetal_Alchemist:_Brotherhood')).toEqual({
      kind: 'search',
      q: 'Fullmetal Alchemist: Brotherhood',
    })
  })
  it('searches any other text, without the link', () => {
    expect(parse('title=Frieren&text=great show')).toEqual({ kind: 'search', q: 'Frieren great show' })
    expect(parse('text=Frieren https://example.com/x')).toEqual({ kind: 'search', q: 'Frieren' })
    expect(parse('url=https://example.com/x')).toEqual({ kind: 'search', q: 'https://example.com/x' })
  })
  it('ignores an AniList link that is no anime page', () => {
    expect(parse('url=https://anilist.co/user/foo').kind).toBe('search')
  })
  it('has nothing to do for an empty share', () => {
    expect(parse('')).toEqual({ kind: 'none' })
  })
})

describe('useAppBadge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'setAppBadge')
    Reflect.deleteProperty(navigator, 'clearAppBadge')
  })
  it('sets the count and clears at zero', () => {
    const set = vi.fn().mockResolvedValue(undefined)
    const clear = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { setAppBadge: set, clearAppBadge: clear })
    const { rerender } = renderHook(({ n }) => useAppBadge(n), { initialProps: { n: 3 } })
    expect(set).toHaveBeenCalledWith(3)
    rerender({ n: 0 })
    expect(clear).toHaveBeenCalledOnce()
  })
  it('does nothing where the Badging API is missing', () => {
    expect(() => renderHook(() => useAppBadge(2))).not.toThrow()
  })
})

describe('shareLink', () => {
  afterEach(() => Reflect.deleteProperty(navigator, 'share'))
  it('uses the share sheet when there is one', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { share })
    expect(await shareLink('https://x.test/title/anilist/1', 'T')).toBe('shared')
    expect(share).toHaveBeenCalledWith({ url: 'https://x.test/title/anilist/1', title: 'T' })
  })
  it('treats a closed sheet as no failure and does not copy', async () => {
    Object.assign(navigator, { share: vi.fn().mockRejectedValue(new DOMException('x', 'AbortError')) })
    const write = vi.fn()
    Object.assign(navigator, { clipboard: { writeText: write } })
    expect(await shareLink('u')).toBe('cancelled')
    expect(write).not.toHaveBeenCalled()
  })
  it('copies when sharing is unavailable', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText: write } })
    expect(await shareLink('u')).toBe('copied')
    expect(write).toHaveBeenCalledWith('u')
  })
})
