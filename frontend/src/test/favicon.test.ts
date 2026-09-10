import { afterEach, describe, expect, it } from 'vitest'
import { faviconSvg, setFavicon } from '../favicon'

describe('favicon', () => {
  afterEach(() => {
    document.head.innerHTML = ''
  })

  it('paints the S in the given accent and the W by colour scheme', () => {
    const svg = faviconSvg('#3fd4e0')
    expect(svg).toContain('fill="#3fd4e0"')
    expect(svg).toContain('prefers-color-scheme:dark')
  })

  it('hands the icon link a data URL with the accent', () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.svg">'
    setFavicon('#c8e04a')
    const href = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href
    expect(href.startsWith('data:image/svg+xml')).toBe(true)
    expect(decodeURIComponent(href)).toContain('#c8e04a')
  })
})
