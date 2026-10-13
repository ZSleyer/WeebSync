import { describe, expect, it } from 'vitest'
import type { WatchEpisode } from '../api'
import { incoming, landingEpisode, langName, matchFiles } from '../components/EpisodeList'

describe('incoming', () => {
  const w = { serverId: 1, remotePath: '/x/Show' }
  const d = (localPath: string, more: Record<string, unknown> = {}) => ({
    status: 'running' as const,
    serverId: 1,
    remotePath: '/x/Show/a.mkv',
    localPath,
    size: 200,
    transferred: 50,
    ...more,
  })
  it('keys a running or queued download of the watch by the episode its target names', () => {
    const got = incoming(
      [
        d('/lib/Show/Show - S01E02.mkv'),
        d('/lib/Show/Show - S01E03.mkv', { status: 'queued', transferred: 0 }),
        d('/lib/Show/Show - S01E04.mkv', { status: 'done' }),
        d('/lib/Other/Other - S01E05.mkv', { remotePath: '/x/Other/b.mkv' }),
        d('/lib/Show/Show - S01E06.mkv', { serverId: 2 }),
        d('/lib/Show/raw name.mkv'),
      ] as Parameters<typeof incoming>[0],
      w,
    )
    expect(Object.fromEntries(got)).toEqual({ '1-2': 0.25, '1-3': 0 })
  })
})

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

describe('landingEpisode', () => {
  const eps = [
    { season: 1, episode: 3, have: true },
    { season: 2, episode: 3, have: true, absolute: 15 },
  ] as WatchEpisode[]
  it('takes the season when given, else the first episode or absolute number', () => {
    expect(landingEpisode(eps, { ep: 3, season: 2 })).toBe(eps[1])
    expect(landingEpisode(eps, { ep: 3 })).toBe(eps[0])
    expect(landingEpisode(eps, { ep: 15 })).toBe(eps[1])
    expect(landingEpisode(eps, { ep: 9 })).toBeUndefined()
  })
})

describe('langName', () => {
  it('names a language tag in the reader language and marks unknown ones', () => {
    expect(langName('ja', 'de')).toBe('Japanisch')
    expect(langName(undefined, 'de')).toBe('?')
    expect(langName('und', 'en')).toBe('?')
  })
})
