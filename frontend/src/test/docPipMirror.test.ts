import { describe, expect, it, vi } from 'vitest'
import { mirrorDocument } from '../components/docPip'

// The picture-in-picture window inherits the page's CSP, and that refuses a
// style attribute set as markup (style-src-attr 'none'). The root's inline
// look has to cross through the CSSOM instead, or the window loses it.
describe('mirrorDocument', () => {
  it('copies the root style through the CSSOM, never as an attribute', () => {
    const from = document.implementation.createHTMLDocument('page')
    from.documentElement.setAttribute('data-theme', 'dark')
    from.documentElement.setAttribute('lang', 'de')
    from.documentElement.style.colorScheme = 'dark'
    const to = document.implementation.createHTMLDocument('pip')
    const setAttribute = vi.spyOn(to.documentElement, 'setAttribute')

    mirrorDocument(from, to)

    expect(setAttribute.mock.calls.map(([name]) => name)).not.toContain('style')
    expect(to.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(to.documentElement.lang).toBe('de')
    expect(to.documentElement.style.colorScheme).toBe('dark')
  })
})
