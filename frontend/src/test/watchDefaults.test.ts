import { describe, expect, it } from 'vitest'
import { applyDefaults, suggestionKind } from '../components/watchDefaults'
import type { WatchDefaults } from '../api'
import type { WatchFields } from '../components/WatchDialog'

const blank: WatchFields = {
  remotePath: '/r/x', localPath: '', mode: 'template', template: '', separator: '', titleOverride: '', pattern: '', replacement: '',
  subfolder: false, mediaId: 0, mediaSource: 'anilist', fromEpisode: 0, airedMapping: false, renameProvider: '', renameOrdering: '',
  renameTitleLang: '', renameSeriesId: 0, wantDub: '', wantSub: '', plexAudioLang: '', plexSubLang: '',
}
const d: WatchDefaults = {
  kinds: {
    'anime-series': { localPath: 'Anime', subfolder: false, subfolderSource: 'title', subfolderSeparator: '_', template: '{title} - {episode:02}', separator: '.' },
    movie: { localPath: 'Filme', subfolder: false, subfolderSource: 'none', subfolderSeparator: '', template: '{title}', separator: '' },
  },
  common: { renameProvider: 'tvdb', renameOrdering: 'official', renameTitleLang: 'de-DE', airedMapping: true, wantDub: 'Ger', wantSub: '', dubLagDays: 0, plexAudioLang: '', plexSubLang: 'off' },
}

describe('applyDefaults', () => {
  it('fills the kind folder and naming when nothing was chosen, plus the common blanks', () => {
    const f = applyDefaults(blank, 'movie', d)
    expect([f.localPath, f.subfolder, f.template, f.separator]).toEqual(['Filme', false, '{title}', ''])
    expect([f.renameProvider, f.renameOrdering, f.renameTitleLang, f.airedMapping, f.wantDub, f.plexSubLang]).toEqual(['tvdb', 'official', 'de-DE', true, 'Ger', 'off'])
  })
  it('keeps a folder a plan already found and a value already set', () => {
    const f = applyDefaults({ ...blank, localPath: '/lib/Frieren/Season 1', template: '{title} - S01E{episode:02}', wantDub: 'Jap' }, 'anime-series', d)
    expect([f.localPath, f.subfolder, f.template, f.wantDub]).toEqual(['/lib/Frieren/Season 1', false, '{title} - S01E{episode:02}', 'Jap'])
  })
  it('passes the subfolder choice on instead of resolving it', () => {
    const f = applyDefaults(blank, 'anime-series', d)
    expect([f.localPath, f.subfolder, f.subfolderSource, f.subfolderSeparator]).toEqual(['Anime', false, 'title', '_'])
  })
  it('falls back to the anime series entry for an unknown kind and does nothing without defaults', () => {
    expect(applyDefaults(blank, 'weird', d).localPath).toBe('Anime')
    expect(applyDefaults(blank, 'movie', undefined)).toEqual(blank)
  })
  it('sends a season to the library folder the show already has, path and template alike', () => {
    const lib = { kind: 'anime-series', title: 'Frieren', season: 2, seasonFolder: 'Season 2', libraryDir: '/lib/Frieren' }
    const f = applyDefaults(blank, 'anime-series', { ...d, common: { ...d.common, airedMapping: false } }, lib)
    expect([f.localPath, f.subfolderSource, f.seasonFolder, f.template]).toEqual(['/lib/Frieren/Season 2', 'none', 'Season 2', '{title} - {episode:02}'])
    // the library speaks even without defaults, and a pinned season only where the template names one
    const g = applyDefaults(blank, 'anime-series', undefined, lib)
    expect([g.localPath, g.template]).toEqual(['/lib/Frieren/Season 2', ''])
    const h = applyDefaults({ ...blank, template: '{title} - S{season:02}E{episode:02}' }, 'anime-series', undefined, lib)
    expect(h.template).toBe('{title} - S02E{episode:02}')
  })
  it('hands the season folder to a title subfolder and keeps it out of a folder template', () => {
    const sub = { kind: 'anime-series', title: 'Frieren', season: 2, seasonFolder: 'Season 02' }
    const f = applyDefaults(blank, 'anime-series', { ...d, common: { ...d.common, airedMapping: false } }, sub)
    expect([f.localPath, f.subfolderSource, f.seasonFolder]).toEqual(['Anime', 'title', 'Season 02'])
    // aired mapping is on in these defaults: the season varies per file
    expect(applyDefaults(blank, 'anime-series', d, sub).seasonFolder).toBeUndefined()
    const folders = { ...d, kinds: { 'anime-series': { ...d.kinds['anime-series']!, template: 'Season {season:02}/{title} - S{season:02}E{episode:02}' } } }
    const g = applyDefaults(blank, 'anime-series', { ...folders, common: { ...d.common, airedMapping: false } }, { ...sub, libraryDir: '/lib/Frieren' })
    expect([g.localPath, g.seasonFolder, g.template]).toEqual(['/lib/Frieren', undefined, 'Season {season:02}/{title} - S{season:02}E{episode:02}'])
  })
  it('maps suggestion categories onto kinds', () => {
    expect(['anime-tv', 'anime-movie', 'animation-tv', 'movie', 'tv'].map(suggestionKind)).toEqual(['anime-series', 'anime-movie', 'series', 'movie', 'series'])
  })
})
