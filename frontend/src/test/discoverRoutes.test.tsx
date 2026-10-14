import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { LegacySuggestions } from '../components/DiscoverRedirect'
import { DISCOVER_SECTIONS, discoverPath, legacyDiscoverPath, sectionOf, slugOf } from '../discoverRoutes'

describe('discover sections', () => {
  it('give every section a German slug and read both slug and old id', () => {
    expect(DISCOVER_SECTIONS.map((s) => s.slug)).toEqual([
      'merkliste',
      'empfohlen',
      'trending',
      'upgrades',
      'unvollstaendig',
      'duplikate',
      'assistent',
      'ausgeblendet',
    ])
    expect(slugOf('incomplete')).toBe('unvollstaendig')
    expect(discoverPath('assistant')).toBe('/discover/assistent')
    expect(sectionOf('duplikate')).toBe('duplicates')
    expect(sectionOf('ignored')).toBe('ignored')
    expect(sectionOf('nope')).toBeUndefined()
    expect(sectionOf(null)).toBeUndefined()
  })

  it('translates every old /suggestions address', () => {
    expect(legacyDiscoverPath('/suggestions')).toBe('/discover')
    expect(legacyDiscoverPath('/suggestions/')).toBe('/discover')
    expect(legacyDiscoverPath('/suggestions/watchlist')).toBe('/discover/merkliste')
    expect(legacyDiscoverPath('/suggestions/recommended')).toBe('/discover/empfohlen')
    expect(legacyDiscoverPath('/suggestions/trending')).toBe('/discover/trending')
    expect(legacyDiscoverPath('/suggestions/upgrades')).toBe('/discover/upgrades')
    expect(legacyDiscoverPath('/suggestions/incomplete')).toBe('/discover/unvollstaendig')
    expect(legacyDiscoverPath('/suggestions/duplicates')).toBe('/discover/duplikate')
    expect(legacyDiscoverPath('/suggestions/assistant')).toBe('/discover/assistent')
    expect(legacyDiscoverPath('/suggestions/ignored')).toBe('/discover/ausgeblendet')
    // the old single page's ?tab=, and a query and hash that ride along
    expect(legacyDiscoverPath('/suggestions?tab=upgrades')).toBe('/discover/upgrades')
    expect(legacyDiscoverPath('/suggestions/upgrades?x=1#top')).toBe('/discover/upgrades?x=1#top')
    expect(legacyDiscoverPath('/suggestions/gone')).toBe('/discover')
    expect(legacyDiscoverPath('/suggestions/a/b')).toBe('/discover')
    // anything else stays as it is
    expect(legacyDiscoverPath('/files')).toBe('/files')
    expect(legacyDiscoverPath('/suggestionsx')).toBe('/suggestionsx')
  })
})

const Where = () => {
  const l = useLocation()
  return <p>{l.pathname + l.search + l.hash}</p>
}

// the redirects as App.tsx mounts them
const mount = (from: string) =>
  render(
    <MemoryRouter initialEntries={[from]}>
      <Routes>
        <Route path="/suggestions/*" element={<LegacySuggestions />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )

describe('discover redirects', () => {
  it('send an old section address to its new one, query and hash included', () => {
    mount('/suggestions/duplicates?sort=size#list')
    expect(screen.getByText('/discover/duplikate?sort=size#list')).toBeInTheDocument()
  })

  it('open the bare old address on the overview', () => {
    mount('/suggestions')
    expect(screen.getByText('/discover')).toBeInTheDocument()
  })
})
