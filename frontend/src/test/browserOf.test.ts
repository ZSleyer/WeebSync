import { describe, expect, it } from 'vitest'
import { browserOf } from '../pages/settings/Account'

describe('browserOf', () => {
  it('names browser and system from a user agent', () => {
    expect(browserOf('Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0')).toBe('Firefox · Linux')
    expect(
      browserOf(
        'Mozilla/5.0 (Linux; Android 14; Pixel 4 XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome · Android')
    expect(
      browserOf(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0',
      ),
    ).toBe('Edge · Windows')
    expect(
      browserOf(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1',
      ),
    ).toBe('Safari · iOS')
    expect(browserOf('')).toBe('')
    expect(browserOf('curl/8.0')).toBe('curl/8.0')
  })
})
