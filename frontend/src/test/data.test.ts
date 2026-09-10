import { describe, expect, it } from 'vitest'
import { groupStores, providerOf, type DataStore } from '../pages/settings/maintenance'

const store = (name: string, kind: DataStore['kind'], rows = 1, bytes = 0, stale = 0): DataStore => ({
  name,
  kind,
  tables: [],
  rows,
  bytes,
  oldest: '',
  newest: '',
  ttlSec: 0,
  stale,
  rebuild: '',
  needs: [],
  keptOnReset: false,
})

describe('providerOf', () => {
  it('reads the provider off the slug and folds the rest', () => {
    expect(providerOf('cache:anilist-search')).toBe('anilist')
    expect(providerOf('cache:tmdb-media')).toBe('tmdb')
    expect(providerOf('cache:tvdb')).toBe('tvdb')
    expect(providerOf('cache:plex')).toBe('plex')
    expect(providerOf('cache:langprobe')).toBe('other')
    expect(providerOf('cache:other')).toBe('other')
  })
})

describe('groupStores', () => {
  it('groups by kind in reading order, the caches by provider, with sums', () => {
    const groups = groupStores([
      store('catalog-decisions', 'decision', 3),
      store('cache:tmdb-search', 'cache', 10, 100, 2),
      store('series', 'derived', 40),
      store('cache:anilist-media', 'cache', 20, 200, 0),
      store('cache:anilist-search', 'cache', 5, 50, 1),
    ])
    expect(groups.map((g) => g.kind)).toEqual(['cache', 'derived', 'decision'])
    const cache = groups[0]
    expect(cache).toMatchObject({ rows: 35, bytes: 350, stale: 3 })
    expect(cache.providers?.map((p) => p.provider)).toEqual(['anilist', 'tmdb'])
    expect(cache.providers?.[0]).toMatchObject({ rows: 25, bytes: 250, stale: 1 })
    expect(cache.providers?.[0].stores.map((s) => s.name)).toEqual(['cache:anilist-media', 'cache:anilist-search'])
    expect(groups[1].providers).toBeUndefined()
    expect(groups[2].rows).toBe(3)
  })

  it('leaves out a kind with no stores', () => {
    expect(groupStores([store('series', 'derived')]).map((g) => g.kind)).toEqual(['derived'])
  })
})
