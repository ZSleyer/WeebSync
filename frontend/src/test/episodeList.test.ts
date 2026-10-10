import { describe, expect, it } from 'vitest'
import type { WatchEpisode } from '../api'
import { matchFiles } from '../components/EpisodeList'

const ep = (season: number, episode: number, more: Partial<WatchEpisode> = {}): WatchEpisode => ({
  season,
  episode,
  have: true,
  ...more,
})
const file = (name: string) => ({ name })
// which episode each file landed on, as SxxEyy, or '-' for the rest
const pairs = (eps: WatchEpisode[], names: string[]) => {
  const { hits, rest } = matchFiles(eps, names.map(file))
  const at = new Map([...hits].map(([e, f]) => [f.name, `S${e.season}E${e.episode}`]))
  return {
    got: Object.fromEntries(names.map((n) => [n, at.get(n) ?? '-'])),
    rest: rest.map((f) => f.name),
  }
}

describe('matchFiles', () => {
  it('pairs a file by the season and episode in its name', () => {
    const eps = [ep(1, 1), ep(1, 2), ep(2, 1)]
    expect(pairs(eps, ['Show - S01E02 [1080p].mkv', 'Show.S02E01.WEB.x264.mkv', 'Show S01E09.mkv']).got).toEqual({
      'Show - S01E02 [1080p].mkv': 'S1E2',
      'Show.S02E01.WEB.x264.mkv': 'S2E1',
      // a season and episode the provider does not list is not guessed at
      'Show S01E09.mkv': '-',
    })
  })

  it('pairs a name with only an absolute number, past resolutions, codecs, hashes and years', () => {
    const eps = [ep(21, 1, { absolute: 1095 }), ep(21, 2, { absolute: 1096 })]
    expect(
      pairs(eps, ['[Group] One Piece - 1095 [1080p][ABCD1234].mkv', 'One Piece (1999) - 1096v2 1080p x264 AAC2.0.mkv'])
        .got,
    ).toEqual({
      '[Group] One Piece - 1095 [1080p][ABCD1234].mkv': 'S21E1',
      'One Piece (1999) - 1096v2 1080p x264 AAC2.0.mkv': 'S21E2',
    })
  })

  it('falls back to the episode number when nothing has that absolute, once per season only', () => {
    expect(pairs([ep(1, 3)], ['Show - 03.mkv']).got).toEqual({
      'Show - 03.mkv': 'S1E3',
    })
    // two seasons share an episode 3: without a season in the name it stays a file
    expect(pairs([ep(1, 3), ep(2, 3)], ['Show - 03.mkv']).rest).toEqual(['Show - 03.mkv'])
  })

  it('compares with the local number an {episode-N} template renumbered to', () => {
    // season 2 counted on from season 1 on disk: provider E01 is file E13
    const eps = [ep(2, 1, { local: 13 }), ep(2, 2, { local: 14 })]
    expect(pairs(eps, ['Show - S02E13.mkv', 'Show - 14.mkv', 'Show - S02E01.mkv']).got).toEqual({
      'Show - S02E13.mkv': 'S2E1',
      'Show - 14.mkv': 'S2E2',
      'Show - S02E01.mkv': '-',
    })
  })

  it('leaves files without a usable number, and a second copy, to the other files', () => {
    const { got, rest } = pairs([ep(1, 1)], ['Show - S01E01.mkv', 'Show - S01E01 v2.mkv', 'Show - NCOP.mkv'])
    expect(got['Show - S01E01.mkv']).toBe('S1E1')
    expect(rest).toEqual(['Show - S01E01 v2.mkv', 'Show - NCOP.mkv'])
  })
})
