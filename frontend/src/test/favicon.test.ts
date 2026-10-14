import { afterEach, describe, expect, it } from 'vitest'
import { faviconSvg, setFavicon } from '../favicon'

describe('favicon', () => {
  afterEach(() => {
    document.head.innerHTML = ''
  })

  it('paints the W and the S in the two accents', () => {
    const svg = faviconSvg('#ef6177', '#33c2b5')
    expect(svg).toContain('fill="#ef6177"')
    expect(svg).toContain('fill="#33c2b5"')
  })

  it('hands the icon link a data URL with both accents', () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.svg">'
    setFavicon('#c8e04a', '#3fd4e0')
    const href = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href
    expect(href.startsWith('data:image/svg+xml')).toBe(true)
    expect(decodeURIComponent(href)).toContain('#c8e04a')
    expect(decodeURIComponent(href)).toContain('#3fd4e0')
  })
})
