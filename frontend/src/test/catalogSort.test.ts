import { describe, expect, it } from 'vitest'
import { filterByStatus, sortGroups, statusGroup, type SortableGroup } from '../components/catalogSort'
import type { Media } from '../api'

const group = (name: string, media?: Partial<Media>, modTime = '2026-01-01T00:00:00Z'): SortableGroup => ({
  media: media && ({ id: 1, title: { romaji: name, english: '' }, ...media } as Media),
  items: [{ entry: { name, path: '/' + name, size: 0, isDir: true, modTime } }],
})

const names = (gs: SortableGroup[]) => gs.map((g) => g.items[0].entry.name)

describe('sortGroups', () => {
  it('orders by title, matched or not', () => {
    const gs = [group('Zeta'), group('alpha', { popularity: 9 }), group('Beta')]
    expect(names(sortGroups(gs, 'title'))).toEqual(['alpha', 'Beta', 'Zeta'])
  })

  it('puts groups without the sorted field last, ordered by title', () => {
    const gs = [
      group('unmatched'),
      group('low', { popularity: 5 }),
      group('empty', {}),
      group('high', { popularity: 50 }),
    ]
    expect(names(sortGroups(gs, 'popularity'))).toEqual(['high', 'low', 'empty', 'unmatched'])
  })

  it('reads dates and airing times oldest/soonest first', () => {
    const gs = [group('later', { startDate: 20260705 }), group('early', { startDate: 20240101 })]
    expect(names(sortGroups(gs, 'startDate'))).toEqual(['early', 'later'])
    const airing = [
      group('week', { nextAiringEpisode: { airingAt: 2000, episode: 3 } }),
      group('today', { nextAiringEpisode: { airingAt: 1000, episode: 2 } }),
    ]
    expect(names(sortGroups(airing, 'nextAiring'))).toEqual(['today', 'week'])
  })

  it('sorts newest folder first when ordering by date added', () => {
    const gs = [group('old', {}, '2026-01-01T00:00:00Z'), group('new', {}, '2026-08-01T00:00:00Z')]
    expect(names(sortGroups(gs, 'added'))).toEqual(['new', 'old'])
  })

  it('groups by studio name and keeps the input untouched', () => {
    const gs = [group('b', { studios: ['Ufotable'] }), group('a', { studios: [] }), group('c', { studios: ['Bones'] })]
    expect(names(sortGroups(gs, 'studio'))).toEqual(['c', 'b', 'a'])
    expect(names(gs)).toEqual(['b', 'a', 'c'])
  })
})

describe('year sort', () => {
  it('puts the newest year first, ties by title, no year last', () => {
    const gs = [
      group('b old', { seasonYear: 2019 }),
      group('none', {}),
      group('b new', { seasonYear: 2026 }),
      group('a new', { seasonYear: 2026 }),
    ]
    expect(names(sortGroups(gs, 'year'))).toEqual(['a new', 'b new', 'b old', 'none'])
  })
})

describe('filterByStatus', () => {
  const gs = [
    group('live', { status: 'RELEASING' }),
    group('soon', { status: 'NOT_YET_RELEASED' }),
    group('done', { status: 'FINISHED' }),
    group('paused', { status: 'HIATUS' }),
    group('unmatched'),
  ]
  it('keeps everything without a filter', () => {
    expect(filterByStatus(gs, '')).toHaveLength(5)
  })
  it('keeps one airing state, paused and cancelled count as finished', () => {
    expect(names(filterByStatus(gs, 'RELEASING'))).toEqual(['live'])
    expect(names(filterByStatus(gs, 'FINISHED'))).toEqual(['done', 'paused'])
  })
  it('maps provider states to filter states', () => {
    expect(statusGroup('CANCELLED')).toBe('FINISHED')
    expect(statusGroup('NOT_YET_RELEASED')).toBe('NOT_YET_RELEASED')
    expect(statusGroup(undefined)).toBe('')
  })
})
