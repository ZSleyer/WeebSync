import { describe, expect, it } from 'vitest'
import type { Entry } from '../api'
import { suggestDirs } from '../components/PathInput'
import { isSeasonFolder } from '../components/RenameOptions'
import { classifyTargets, syncTargetDir } from '../components/useTargetFolder'

const dir = (name: string): Entry => ({ name, path: name, size: 0, isDir: true, modTime: '' })
const file = (name: string): Entry => ({ ...dir(name), isDir: false })

const LISTING: Entry[] = [dir('Anime'), dir('anime-movies'), dir('Docs'), file('Anime.txt')]

describe('suggestDirs', () => {
  it('matches the last segment case-insensitively and keeps the parent path', () => {
    expect(suggestDirs('media/an', LISTING)).toEqual(['media/Anime', 'media/anime-movies'])
  })

  it('works root-relative, without a leading slash on the result', () => {
    expect(suggestDirs('an', LISTING)).toEqual(['Anime', 'anime-movies'])
  })

  it('offers every directory for an empty partial', () => {
    expect(suggestDirs('', LISTING)).toEqual(['Anime', 'anime-movies', 'Docs'])
  })

  it('offers every directory of a parent when the path ends in a slash', () => {
    expect(suggestDirs('media/', LISTING)).toEqual(['media/Anime', 'media/anime-movies', 'media/Docs'])
  })

  it('never suggests files, only directories', () => {
    expect(suggestDirs('anime.', LISTING)).toEqual([])
  })

  it('returns nothing when the prefix matches nothing', () => {
    expect(suggestDirs('zz', LISTING)).toEqual([])
  })

  it('sorts by name, independent of the listing order', () => {
    expect(suggestDirs('', [dir('zeta'), dir('alpha'), dir('Beta')])).toEqual(['alpha', 'Beta', 'zeta'])
  })

  it('keeps deeper parents intact', () => {
    expect(suggestDirs('a/b/c/Do', LISTING)).toEqual(['a/b/c/Docs'])
  })
})

describe('isSeasonFolder', () => {
  it.each(['Season 3', 'season 12', 'Staffel 2', 'Saison 1', 'Temporada 4', 'Stagione 2', 'S02', 's7', 'Specials'])(
    'recognises %s',
    (name) => {
      expect(isSeasonFolder(name)).toBe(true)
    },
  )

  it.each(['Detective Conan', 'Movies', 'Season', 'S123', 'Extras'])('leaves %s alone', (name) => {
    expect(isSeasonFolder(name)).toBe(false)
  })
})

describe('syncTargetDir', () => {
  it('appends the remote folder name when a subfolder is wanted', () => {
    expect(syncTargetDir('/media/plex/Show', '/ftp/Show S02 [Sub]', true)).toBe('/media/plex/Show/Show S02 [Sub]')
  })

  it('writes straight into localPath when it is not', () => {
    expect(syncTargetDir('/media/plex/Show/Season 02', '/ftp/Show S02', false)).toBe('/media/plex/Show/Season 02')
  })

  it('ignores a trailing slash on the remote path', () => {
    expect(syncTargetDir('/target', '/ftp/Show/', true)).toBe('/target/Show')
  })

  it('does not lead with a slash when localPath is empty', () => {
    expect(syncTargetDir('', '/ftp/Show', true)).toBe('Show')
  })
})

describe('classifyTargets', () => {
  const pair = (name: string, to = name) => ({ old: name, new: to })
  const localFile = (name: string, size: number): Entry => ({ ...file(name), size })

  it('marks everything new when the target folder is not there yet', () => {
    expect(classifyTargets([pair('a.mkv')], { 'a.mkv': 10 }, null)).toEqual({ 'a.mkv': 'new' })
  })

  it('marks nothing at all when the listing is unknown', () => {
    expect(classifyTargets([pair('a.mkv')], { 'a.mkv': 10 }, undefined)).toEqual({})
  })

  it('calls a same-name same-size file identical, the way the transfer skips it', () => {
    expect(classifyTargets([pair('a.mkv', 'S01E01.mkv')], { 'a.mkv': 10 }, [localFile('S01E01.mkv', 10)])).toEqual({
      'a.mkv': 'same',
    })
  })

  it('calls a differing size a replacement - the upgrade case', () => {
    expect(classifyTargets([pair('a.mkv', 'S01E01.mkv')], { 'a.mkv': 99 }, [localFile('S01E01.mkv', 10)])).toEqual({
      'a.mkv': 'replaces',
    })
  })

  it('treats an unknown remote size as a replacement rather than as identical', () => {
    expect(classifyTargets([pair('a.mkv')], {}, [localFile('a.mkv', 0)])).toEqual({ 'a.mkv': 'replaces' })
  })

  it('leaves a name that lands in a subfolder unmarked', () => {
    expect(classifyTargets([pair('a.mkv', 'Season 02/a.mkv')], { 'a.mkv': 10 }, [])).toEqual({})
  })

  it('does not let a directory of the same name count as a collision', () => {
    expect(classifyTargets([pair('Extras')], { Extras: 10 }, [dir('Extras')])).toEqual({ Extras: 'new' })
  })
})
