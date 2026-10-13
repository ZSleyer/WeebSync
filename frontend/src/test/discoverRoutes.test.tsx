import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { DiscoverIndex, LegacySuggestions } from '../components/DiscoverRedirect'
import {
  DISCOVER_SECTIONS,
  discoverPath,
  lastSection,
  legacyDiscoverPath,
  rememberSection,
  sectionOf,
  slugOf,
} from '../discoverRoutes'

afterEach(() => localStorage.clear())

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

  it('remember the last section per browser, Merkliste at first', () => {
    expect(lastSection()).toBe('watchlist')
    rememberSection('upgrades')
    expect(lastSection()).toBe('upgrades')
    // a stored value that names no section falls back to the default
    localStorage.setItem('ws-dsec', 'bogus')
    expect(lastSection()).toBe('watchlist')
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
        <Route path="/discover" element={<DiscoverIndex />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )

describe('discover redirects', () => {
  it('send an old section address to its new one, query and hash included', () => {
    mount('/suggestions/duplicates?sort=size#list')
    expect(screen.getByText('/discover/duplikate?sort=size#list')).toBeInTheDocument()
  })

  it('open the bare old address on the last section used', () => {
    rememberSection('trending')
    mount('/suggestions')
    expect(screen.getByText('/discover/trending')).toBeInTheDocument()
  })

  it('open /discover on Merkliste the first time and on the last section after', () => {
    const first = mount('/discover')
    expect(screen.getByText('/discover/merkliste')).toBeInTheDocument()
    first.unmount()
    rememberSection('assistant')
    mount('/discover')
    expect(screen.getByText('/discover/assistent')).toBeInTheDocument()
  })

  it('honour the old ?tab= on the new index too', () => {
    mount('/discover?tab=incomplete')
    expect(screen.getByText('/discover/unvollstaendig')).toBeInTheDocument()
  })
})
