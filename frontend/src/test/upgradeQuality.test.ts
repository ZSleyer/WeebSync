import { describe, expect, it } from 'vitest'
import { fmtEpisodeRanges, variantDiff } from '../components/upgradeQuality'

describe('fmtEpisodeRanges', () => {
  it('folds runs into ranges and keeps singles apart', () => {
    expect(fmtEpisodeRanges([4, 6, 7, 8, 12])).toBe('E4, E6-E8, E12')
    expect(fmtEpisodeRanges([2, 3])).toBe('E2, E3')
    expect(fmtEpisodeRanges([])).toBe('')
  })
})

describe('variantDiff', () => {
  const t = (k: string) => k
  const from = { serverId: 0, folder: '/a', resRank: 1080, dub: ['Jap'], sub: ['Ger'], soft: [], probed: 1 }
  it('names the resolution step and added languages on enabled axes', () => {
    const v = { serverId: 1, folder: '/b', resRank: 2160, dub: ['Jap', 'Ger'], sub: ['Ger'], soft: ['Ger'], probed: 1 }
    expect(variantDiff(from, v, { res: true, sub: true, dub: false, soft: true, order: ['res', 'soft', 'sub'] }, t)).toEqual([
      '1080p → 4K',
      'suggestions.upSoft Ger',
    ])
  })
})
