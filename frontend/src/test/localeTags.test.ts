import { describe, expect, it } from 'vitest'
import de from '../locales/de.json'
import en from '../locales/en.json'

// <Trans> places a component by name. An index tag (<1>) breaks as soon as the
// JSX around it changes, and an HTML void name (<link>, <img>, <br>) is parsed
// as empty, so the linked words land after the link instead of inside it.
const VOID = /<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)>/

const strings = (o: unknown): string[] =>
  typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : []

describe('locale tags', () => {
  it.each([
    ['de', de],
    ['en', en],
  ])('%s names its Trans components', (_, locale) => {
    const bad = strings(locale).filter((s) => /<\d+>/.test(s) || VOID.test(s))
    expect(bad).toEqual([])
  })
})
