import { describe, expect, it } from 'vitest'
import i18n from '../locales'
import { asOfLine, copyLine, listOf, metaLine, progressLine, shortPath } from '../pages/discoverText'

const de = i18n.getFixedT('de')
const en = i18n.getFixedT('en')

describe('Entdecken row text', () => {
  it('shortens a server path to what tells it apart', () => {
    expect(shortPath('/anime/Frieren S02 [1080p WEB]')).toBe('Frieren S02')
    expect(shortPath('/data/BD-DVD/One-Punch Man/')).toBe('BD-DVD/One-Punch Man')
    expect(shortPath('Lonely')).toBe('Lonely')
  })

  it('builds the meta line from what is known', () => {
    expect(metaLine({ year: 2026, category: 'anime-tv', episodes: 12, score: 84 }, de)).toBe(
      '2026 · Anime-Serie · 12 Folgen · 84 %',
    )
    expect(metaLine({ category: 'movie', episodes: 1 }, en)).toBe('Movie · 1 episode')
    // an unknown category falls back to the library
    expect(metaLine({ category: 'other', library: 'Filme 4K' }, de)).toBe('Filme 4K')
    expect(metaLine({}, de)).toBe('')
  })

  it('says what a copy carries, burned-in subtitles included', () => {
    expect(copyLine({ resRank: 1080, dub: ['Jpn'], sub: ['Eng', 'Ger'], soft: ['Eng', 'Ger'] }, de)).toBe(
      '1080p · Ton Jpn · UT Eng+Ger wählbar',
    )
    expect(copyLine({ resRank: 0, dub: ['Und'], sub: [], soft: [] }, de)).toBe('Auflösung ? · Ton unbekannt · UT keine')
    expect(copyLine({ resRank: 2160, dub: ['Jpn', 'Ger'], sub: ['Ger'], soft: [] }, de)).toBe(
      '4K · Ton Jpn+Ger · UT Ger eingebrannt',
    )
    expect(copyLine({ resRank: 720, dub: [], sub: ['Eng', 'Ger'], soft: ['Eng'] }, en)).toBe(
      '720p · Audio unknown · Subs Eng selectable, Ger burned in',
    )
  })

  it('counts progress with and without a total', () => {
    expect(progressLine(3, 12, de)).toBe('gesehen 3 von 12')
    expect(progressLine(3, 0, de)).toBe('gesehen 3')
  })

  it('joins titles the way the language does', () => {
    expect(listOf(['A', 'B', 'C'], 'de')).toBe('A, B und C')
    expect(listOf(['A', 'B'], 'en')).toBe('A and B')
  })

  it('says how current the lists are', () => {
    const now = new Date(2026, 9, 14, 18, 0).getTime()
    expect(asOfLine(new Date(2026, 9, 14, 9, 5).getTime(), now, 'de', de)).toBe(
      'Stand von heute, 09:05. WeebSync prüft alle 30 Minuten neu.',
    )
    expect(asOfLine(new Date(2026, 9, 12, 9, 5).getTime(), now, 'de', de)).toMatch(/^Stand vom 12\.10\.?, 09:05\./)
  })
})
