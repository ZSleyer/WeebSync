import { describe, expect, it } from 'vitest'
import type { Watch } from '../api'
import { groupWatches } from '../watchGroups'

const NOW = new Date('2026-10-14T12:00:00').getTime()
const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)
const w = (id: number, over: Partial<Watch> = {}): Watch =>
  ({
    id,
    titleOverride: `Show ${String.fromCharCode(64 + id)}`,
    remotePath: `/x/${id}`,
    template: 'Show S01E{{ep}}.mkv',
    lastCheck: '',
    nextCheck: 0,
    nextAiringAt: 0,
    complete: false,
    waiting: false,
    active: 0,
    attention: [],
    localFiles: 1,
    seasons: [1],
    ...over,
  }) as unknown as Watch

const keys = (sort: Parameters<typeof groupWatches>[1], list: Watch[], dir: 'asc' | 'desc' = 'asc') =>
  groupWatches(list, sort, dir, NOW).map((g) => `${g.key}:${g.watches.map((x) => x.id).join(',')}`)

describe('Auto-Sync sections', () => {
  const list = [
    w(1, { nextAiringAt: at('2026-10-14T20:00:00') }),
    w(2, { nextAiringAt: at('2026-10-15T09:00:00') }),
    w(3, { nextAiringAt: at('2026-10-18T09:00:00') }),
    w(4, { nextAiringAt: at('2026-11-02T09:00:00') }),
    w(5, { complete: true }),
    w(6, { attention: [{ kind: 'gap' }] as unknown as Watch['attention'], nextAiringAt: at('2026-10-14T13:00:00') }),
    w(7),
  ]

  it('sorts by next sync into days, what needs a hand first and the finished last', () => {
    expect(keys('next', list)).toEqual([
      'attention:6',
      'today:1',
      'tomorrow:2',
      'week:3',
      'later:4',
      'none:7',
      'complete:5',
    ])
  })

  it('turns sections and order around for descending, but keeps what needs a hand on top', () => {
    expect(keys('next', list, 'desc')[0]).toBe('attention:6')
    expect(keys('next', list, 'desc')[1]).toBe('complete:5')
  })

  it('groups by status in the order of what each watch is doing', () => {
    const s = [
      w(1, { active: 1 }),
      w(2, { nextAiringAt: at('2026-10-15T09:00:00') }),
      w(3, { waiting: true }),
      w(4, { complete: true }),
      w(5),
      w(6, { dubProgress: { lang: 'Ger', have: 15, total: 19, next: { s: 1, e: 16 } } }),
    ]
    expect(keys('status', s)).toEqual(['syncing:1', 'airing:2', 'waiting:3,6', 'idle:5', 'complete:4'])
  })

  it('gives names their letter, accents folded, the rest under #', () => {
    const s = [w(1, { titleOverride: 'Ärger' }), w(2, { titleOverride: 'Ano' }), w(3, { titleOverride: '86' })]
    expect(keys('name', s)).toEqual(['letter-#:3', 'letter-A:2,1'])
  })

  it('puts last checks into today, yesterday, this week, older and never', () => {
    const s = [
      w(1, { lastCheck: '2026-10-14 08:00:00' }),
      w(2, { lastCheck: '2026-10-13 08:00:00' }),
      w(3, { lastCheck: '2026-10-01 08:00:00' }),
      w(4),
    ]
    expect(keys('last', s).map((k) => k.split(':')[0])).toEqual(['today', 'yesterday', 'older', 'never'])
  })
})
