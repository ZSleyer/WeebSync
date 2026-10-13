import { afterEach, describe, expect, it } from 'vitest'
import { applyScheme, readScheme, schemeFromStored, SCHEME_KEY } from '../scheme'

describe('schemeFromStored', () => {
  it('keeps a stored scheme', () => {
    expect(schemeFromStored('recoil', 'orange')).toBe('recoil')
    expect(schemeFromStored('lycoris', 'cyan')).toBe('lycoris')
  })
  it('maps an old cool accent to Recoil and every other one to Lycoris', () => {
    for (const a of ['cyan', 'blue', 'green']) expect(schemeFromStored(null, a)).toBe('recoil')
    for (const a of ['orange', 'crimson', 'pink', 'violet', 'acid']) expect(schemeFromStored(null, a)).toBe('lycoris')
  })
  it('falls back to Lycoris for nothing or garbage', () => {
    expect(schemeFromStored(null, null)).toBe('lycoris')
    expect(schemeFromStored('neon', 'x')).toBe('lycoris')
  })
})

describe('readScheme', () => {
  afterEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.scheme
    delete document.documentElement.dataset.accent
  })

  it('moves an old accent over to its scheme once and forgets the accent', () => {
    localStorage.setItem('weebsync.accent', 'cyan')
    localStorage.setItem('weebsync.accent.v2', '1')
    expect(readScheme()).toBe('recoil')
    expect(localStorage.getItem(SCHEME_KEY)).toBe('recoil')
    expect(localStorage.getItem('weebsync.accent')).toBeNull()
    expect(localStorage.getItem('weebsync.accent.v2')).toBeNull()
    expect(readScheme()).toBe('recoil')
  })

  it('applies Recoil as an attribute and Lycoris as none, dropping an old accent attribute', () => {
    document.documentElement.dataset.accent = 'violet'
    applyScheme('recoil')
    expect(document.documentElement.dataset.scheme).toBe('recoil')
    expect(document.documentElement.dataset.accent).toBeUndefined()
    applyScheme('lycoris')
    expect(document.documentElement.dataset.scheme).toBeUndefined()
  })
})
