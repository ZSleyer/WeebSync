import { describe, expect, it } from 'vitest'
import type { Watch } from '../api'
import {
  calDayHeading,
  checkCell,
  dayLabel,
  diskName,
  matchesFilter,
  nextCell,
  normalizeFilter,
  tileSub,
} from '../watchTiles'

// keys with their options, so a test reads what the line would say
const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}${JSON.stringify(o)}` : k)

const w = (over: Partial<Watch> = {}): Watch =>
  ({
    id: 1,
    remotePath: '/r/Frieren',
    localPath: '/media/disk1/Anime/Frieren',
    titleOverride: '',
    localFiles: 2,
    active: 0,
    complete: false,
    seasons: [3],
    media: { episodes: 12, status: 'RELEASING' },
    ...over,
  }) as unknown as Watch

describe('the filter', () => {
  it('sorts watches into airing, gaps and done', () => {
    expect(matchesFilter(w(), 'airing')).toBe(true)
    expect(matchesFilter(w({ media: { status: 'FINISHED' } as Watch['media'] }), 'airing')).toBe(false)
    expect(matchesFilter(w({ media: { status: 'FINISHED' } as Watch['media'], nextAiringAt: 5 }), 'airing')).toBe(true)
    expect(matchesFilter(w({ missing: [{ e: 3 }] as Watch['missing'] }), 'gaps')).toBe(true)
    expect(matchesFilter(w(), 'gaps')).toBe(false)
    expect(matchesFilter(w({ complete: true }), 'done')).toBe(true)
    expect(matchesFilter(w(), 'all')).toBe(true)
  })
  it('opens the gaps for the old attention address and falls back to all', () => {
    expect(normalizeFilter('attention')).toBe('gaps')
    expect(normalizeFilter('done')).toBe('done')
    expect(normalizeFilter('nonsense')).toBe('all')
  })
})

describe('the tile line', () => {
  it('counts a season against its total', () => {
    expect(tileSub(t, w()).text).toBe(
      'watch.tile.season{"n":3,"have":"watch.tile.haveOf{\\"have\\":2,\\"total\\":12}"}',
    )
  })
  it('says what is missing, in the gap tone', () => {
    const s = tileSub(t, w({ missing: [{ e: 1 }, { e: 2 }] as Watch['missing'], attention: ['missing'] }))
    expect(s).toEqual({ text: 'watch.tile.missing{"count":2}', tone: 'gap', loading: false })
  })
  it('puts a failed check before the gaps', () => {
    const s = tileSub(t, w({ missing: [{ e: 1 }] as Watch['missing'], attention: ['checkFailed', 'missing'] }))
    expect(s.tone).toBe('err')
    expect(s.text).toBe('dash.checkFailed')
  })
  it('names a finished season, and a long runner by its absolute episode', () => {
    expect(tileSub(t, w({ complete: true })).text).toBe('watch.tile.seasonComplete{"n":3}')
    expect(tileSub(t, w({ complete: true, seasons: [] })).text).toBe('watch.tile.complete')
    const op = w({
      seasons: [],
      media: { episodes: 0, status: 'RELEASING' } as Watch['media'],
      localFiles: 1100,
      nextEpisode: 1181,
    })
    expect(tileSub(t, op).text).toBe('watch.tile.absolute{"n":1180}')
  })
  it('counts the dub instead of the episodes once a season is all there', () => {
    const dubProgress = { lang: 'Ger', have: 15, total: 19, next: { s: 4, e: 16 } }
    const rz = w({
      seasons: [4],
      localFiles: 19,
      media: { episodes: 19, status: 'FINISHED' } as Watch['media'],
      dubProgress,
    })
    expect(tileSub(t, rz).text).toBe(
      'watch.tile.season{"n":4,"have":"watch.tile.dub{\\"lang\\":\\"Ger\\",\\"have\\":15,\\"total\\":19}"}',
    )
    // still short of episodes: the count says more than the dub
    expect(tileSub(t, w({ dubProgress })).text).toMatch(/^watch\.tile\.season\{/)
  })
  it('marks a running download', () => {
    expect(tileSub(t, w({ active: 1 })).loading).toBe(true)
  })
})

describe('the list columns', () => {
  const now = new Date(2026, 9, 14, 12).getTime()
  it('names the next episode by day', () => {
    const at = new Date(2026, 9, 15, 16).getTime() / 1000
    expect(dayLabel(t, at, now)).toBe('watch.list.tomorrow')
    expect(dayLabel(t, now / 1000, now)).toBe('watch.list.today')
    expect(nextCell(t, w({ nextAiringAt: at, nextEpisode: 4 }), now)).toMatch(
      /^watch\.list\.next\{"n":4,"day":"watch\.list\.tomorrow"/,
    )
    expect(nextCell(t, w({ media: { status: 'FINISHED' } as Watch['media'] }), now)).toBe('watch.list.finished')
    expect(nextCell(t, w(), now)).toBe('watch.list.noDate')
  })
  it('takes the disk from the first folder past the mount point', () => {
    expect(diskName('/media/disk1/Anime/Frieren')).toBe('disk1')
    expect(diskName('/srv/ran/x')).toBe('ran')
    expect(diskName('/downloads')).toBe('downloads')
  })
  it('states gap, waiting or done', () => {
    expect(checkCell(t, w({ missing: [{ e: 1 }] as Watch['missing'] }))).toBe('watch.list.gap')
    expect(checkCell(t, w())).toBe('watch.list.waiting')
    expect(checkCell(t, w({ complete: true }))).toBe('watch.list.done')
    const dubProgress = { lang: 'Ger', have: 15, total: 19, next: { s: 4, e: 16 } }
    const rz = w({ media: { status: 'FINISHED' } as Watch['media'], dubProgress })
    expect(checkCell(t, rz)).toBe('watch.list.dubOpen')
  })
  it('heads the calendar days today, tomorrow, then by weekday', () => {
    const today = new Date(2026, 9, 14)
    expect(calDayHeading(t, today, today)).toBe('watch.week.today')
    expect(calDayHeading(t, new Date(2026, 9, 15), today)).toBe('watch.cal.tomorrow')
    expect(calDayHeading(t, new Date(2026, 9, 16), today)).not.toMatch(/^watch\./)
  })
})
