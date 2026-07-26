import { describe, expect, it } from 'vitest'
import {
  downloadLabel,
  fmtBytes,
  fmtMissing,
  fmtSpeed,
  mediaTitle,
  syncOutcome,
  type Download,
  type DownloadMeta,
} from '../api'

// The pure formatters out of api.ts. No fetch, no query client - importing the
// module only defines functions, so these run without a backend.

describe('mediaTitle', () => {
  it('prefers the canonical localized title', () => {
    expect(mediaTitle({ title: { preferred: 'Frieren', romaji: 'Sousou no Frieren', english: 'Frieren' } })).toBe(
      'Frieren',
    )
  })

  it('falls back to romaji when there is no preferred title', () => {
    expect(mediaTitle({ title: { romaji: 'Sousou no Frieren', english: 'Frieren' } })).toBe('Sousou no Frieren')
  })

  it('skips a native-script romaji and takes english instead', () => {
    expect(mediaTitle({ title: { romaji: '葬送のフリーレン', english: 'Frieren' } })).toBe('Frieren')
  })

  it('rejects kana as well as kanji', () => {
    expect(mediaTitle({ title: { romaji: 'それでも歩は寄せてくる', english: 'When Will Ayumu Make His Move?' } })).toBe(
      'When Will Ayumu Make His Move?',
    )
  })

  it('returns a native title anyway when it is the only one there is', () => {
    expect(mediaTitle({ title: { romaji: '葬送のフリーレン' } })).toBe('葬送のフリーレン')
    expect(mediaTitle({ title: { english: '葬送のフリーレン' } })).toBe('葬送のフリーレン')
  })

  it('uses the fallback for missing, empty and null media', () => {
    expect(mediaTitle(undefined, 'Unbekannt')).toBe('Unbekannt')
    expect(mediaTitle(null, 'Unbekannt')).toBe('Unbekannt')
    expect(mediaTitle({}, 'Unbekannt')).toBe('Unbekannt')
    expect(mediaTitle({ title: {} }, 'Unbekannt')).toBe('Unbekannt')
  })

  it('defaults the fallback to an empty string', () => {
    expect(mediaTitle(undefined)).toBe('')
  })

  it('keeps a latin title with accents and punctuation', () => {
    expect(mediaTitle({ title: { romaji: 'Fate/stay night: Unlimited Blade Works' } })).toBe(
      'Fate/stay night: Unlimited Blade Works',
    )
  })
})

describe('fmtMissing', () => {
  it('joins the numbers with commas', () => {
    expect(fmtMissing([1, 2, 3])).toBe('1, 2, 3')
  })

  it('caps the list at five entries', () => {
    expect(fmtMissing([1, 2, 3, 4, 5, 6, 7])).toBe('1, 2, 3, 4, 5')
  })

  it('appends the original absolute number when a renumber offset is active', () => {
    // a series renumbered from absolute 1206 down to 59 carries offset -1147
    expect(fmtMissing([59, 60], -1147)).toBe('59 (1206), 60 (1207)')
  })

  it('treats a zero offset as no offset', () => {
    expect(fmtMissing([12], 0)).toBe('12')
  })

  it('renders an empty list as an empty string', () => {
    expect(fmtMissing([])).toBe('')
  })
})

describe('fmtBytes', () => {
  it('keeps raw bytes below the first step', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(1023)).toBe('1023 B')
  })

  it('switches unit at every 1024 boundary', () => {
    expect(fmtBytes(1024)).toBe('1.0 KiB')
    expect(fmtBytes(1024 ** 2)).toBe('1.0 MiB')
    expect(fmtBytes(1024 ** 3)).toBe('1.0 GiB')
    expect(fmtBytes(1024 ** 4)).toBe('1.0 TiB')
  })

  it('drops the decimal from three digits upwards, so the column stays narrow', () => {
    expect(fmtBytes(99.4 * 1024)).toBe('99.4 KiB')
    expect(fmtBytes(100 * 1024)).toBe('100 KiB')
    expect(fmtBytes(1023 * 1024)).toBe('1023 KiB')
  })

  it('stops at the largest unit instead of inventing one', () => {
    expect(fmtBytes(2048 * 1024 ** 4)).toBe('2048 TiB')
  })
})

describe('fmtSpeed', () => {
  it('is fmtBytes per second', () => {
    expect(fmtSpeed(0)).toBe('0 B/s')
    expect(fmtSpeed(1024)).toBe('1.0 KiB/s')
    expect(fmtSpeed(12.5 * 1024 ** 2)).toBe('12.5 MiB/s')
  })
})

describe('syncOutcome', () => {
  // t is only used for lookups here, so echoing the key with its count keeps
  // the assertions about the logic rather than about the wording
  const t = (k: string, o?: Record<string, unknown>) => (o?.count !== undefined ? `${k}:${o.count}` : (o?.reasons as string) ?? k)

  it('says nothing when files were queued - the queue is the answer', () => {
    expect(syncOutcome({ queued: 3, skipped: 2 }, t)).toBe('')
  })

  it('names the reason when nothing was queued', () => {
    expect(syncOutcome({ queued: 0, skipped: 12 }, t)).toBe('remote.syncSkipped:12')
  })

  it('lists every reason that applies', () => {
    expect(syncOutcome({ queued: 0, skipped: 1, uploading: 2, filtered: 3 }, t)).toBe(
      'remote.syncSkipped:1, remote.syncUploading:2, remote.syncFiltered:3',
    )
  })

  it('falls back to a plain answer when nothing explains it', () => {
    expect(syncOutcome({ queued: 0 }, t)).toBe('remote.syncNothing')
  })
})

describe('downloadLabel', () => {
  const dl = (remotePath: string, localPath = remotePath): Download =>
    ({ id: 1, remotePath, localPath }) as Download

  it('falls back to the file name without metadata', () => {
    expect(downloadLabel(dl('/lib/Show/e1.mkv'))).toMatchObject({ label: 'e1.mkv', ep: '' })
  })

  it('builds show, episode and title when all three are known', () => {
    const meta: DownloadMeta = {
      groups: { g: { serverId: 1, folder: '/lib/Show', title: 'Some Show', links: {} } },
      items: { '1': { g: 'g', season: 3, episode: 5, title: 'The Reveal' } },
    }
    expect(downloadLabel(dl('/lib/Show/e5.mkv'), meta)).toMatchObject({
      label: 'Some Show - The Reveal',
      ep: 'S03E05',
    })
  })

  it('keeps a plain number when no season was parsed', () => {
    const meta: DownloadMeta = {
      groups: { g: { serverId: 1, folder: '/lib/Show', title: 'Some Show', links: {} } },
      items: { '1': { g: 'g', episode: 1187 } },
    }
    expect(downloadLabel(dl('/lib/Show/e1187.mkv'), meta)).toMatchObject({ label: 'Some Show', ep: 'E1187' })
  })

  it('keeps the file name when the folder has no match', () => {
    const meta: DownloadMeta = {
      groups: { g: { serverId: 1, folder: '/lib/Unknown', links: {} } },
      items: { '1': { g: 'g', season: 1, episode: 2 } },
    }
    expect(downloadLabel(dl('/lib/Unknown/e2.mkv'), meta)).toMatchObject({ label: 'e2.mkv', ep: '' })
  })
})
