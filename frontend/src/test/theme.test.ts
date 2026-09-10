import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, readThemePref, resolveTheme, THEME_KEY } from '../theme'

type Listener = (e: { matches: boolean }) => void

// jsdom has no matchMedia: a stub with a switchable answer and a change event
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>()
  const mql = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  }
  window.matchMedia = (() => mql) as unknown as typeof window.matchMedia
  return {
    flip(next: boolean) {
      mql.matches = next
      listeners.forEach((fn) => fn({ matches: next }))
    },
    listeners,
  }
}

describe('resolveTheme', () => {
  it('follows the OS only for system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })
})

describe('readThemePref', () => {
  afterEach(() => localStorage.clear())
  it('is system when nothing or nonsense is stored', () => {
    expect(readThemePref()).toBe('system')
    localStorage.setItem(THEME_KEY, 'sepia')
    expect(readThemePref()).toBe('system')
  })
  it('keeps a stored choice', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    expect(readThemePref()).toBe('dark')
  })
})

describe('applyTheme', () => {
  const real = window.matchMedia
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#000">'
  })
  afterEach(() => {
    window.matchMedia = real
    delete document.documentElement.dataset.theme
    vi.restoreAllMocks()
  })
  const meta = () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content')

  it('paints the resolved theme and the browser chrome', () => {
    stubMatchMedia(false)
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(meta()).toBe('#0b0b0d')
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(meta()).toBe('#f8fafb')
  })

  it('follows the OS while set to system, and stops once fixed', () => {
    const mm = stubMatchMedia(true)
    applyTheme('system')
    expect(document.documentElement.dataset.theme).toBe('dark')
    mm.flip(false)
    expect(document.documentElement.dataset.theme).toBe('light')
    applyTheme('dark')
    expect(mm.listeners.size).toBe(0)
    mm.flip(true)
    mm.flip(false)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
