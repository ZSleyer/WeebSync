import { expect, test } from 'vitest'
import { mediaDescription } from '../api'

test('the overview in the reader language, the default where it has none', () => {
  const m = { description: 'Deutsch', descriptions: { de: 'Deutsch', en: 'English' } }
  expect(mediaDescription(m, 'en-US')).toBe('English')
  expect(mediaDescription(m, 'de')).toBe('Deutsch')
  expect(mediaDescription({ description: 'AniList only' }, 'de')).toBe('AniList only')
  expect(mediaDescription(m, undefined)).toBe('Deutsch')
})
