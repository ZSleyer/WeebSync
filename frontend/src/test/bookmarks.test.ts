import { describe, expect, it } from 'vitest'
import { addBookmark, hasBookmark, parseBookmarks, removeBookmark } from '../components/bookmarks'

describe('bookmarks', () => {
  it('adds once, ignoring slashes around the path', () => {
    let l = addBookmark([], { source: 3, path: '/Anime/2026-Fall/' })
    l = addBookmark(l, { source: 3, path: 'Anime/2026-Fall' })
    expect(l).toEqual([{ source: 3, path: 'Anime/2026-Fall' }])
    l = addBookmark(l, { source: 'local', path: 'Anime/2026-Fall' })
    expect(l).toHaveLength(2)
  })
  it('removes only the matching source and path', () => {
    const l = [
      { source: 3 as const, path: 'a' },
      { source: 'local' as const, path: 'a' },
    ]
    const r = removeBookmark(l, { source: 3, path: '/a' })
    expect(r).toEqual([{ source: 'local', path: 'a' }])
    expect(hasBookmark(r, { source: 3, path: 'a' })).toBe(false)
  })
  it('drops malformed storage', () => {
    expect(parseBookmarks('nope')).toEqual([])
    expect(parseBookmarks('[{"source":0,"path":"x"},{"source":"local","path":"/m"},5]')).toEqual([
      { source: 'local', path: 'm' },
    ])
  })
})
