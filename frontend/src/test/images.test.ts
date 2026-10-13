import { afterEach, describe, expect, it, vi } from 'vitest'
import { coverSet, lowData, personSet } from '../images'

describe('image sets', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('turns every cover size into a width srcset with the large one as fallback', () => {
    expect(coverSet({ medium: '/m.jpg', large: '/l.jpg', extraLarge: '/x.jpg' })).toEqual({
      src: '/l.jpg',
      srcSet: '/m.jpg 100w, /l.jpg 230w, /x.jpg 460w',
      small: '/m.jpg',
    })
  })

  it('stays a plain src when a cache from before the sizes holds one picture', () => {
    expect(coverSet({ large: '/l.jpg' })).toEqual({ src: '/l.jpg', srcSet: undefined, small: undefined })
    expect(coverSet({ large: '/l.jpg', extraLarge: '/l.jpg' })).toEqual({
      src: '/l.jpg',
      srcSet: undefined,
      small: undefined,
    })
    expect(coverSet(null)).toBeUndefined()
    expect(coverSet({})).toBeUndefined()
  })

  it('gives portraits their two sizes', () => {
    expect(personSet('/m.jpg', '/l.jpg')).toEqual({
      src: '/l.jpg',
      srcSet: '/m.jpg 100w, /l.jpg 230w',
      small: '/m.jpg',
    })
    expect(personSet('/m.jpg')).toEqual({ src: '/m.jpg', srcSet: undefined, small: undefined })
  })

  it('reads slow and data-saving connections as low data', () => {
    vi.stubGlobal('navigator', { connection: { effectiveType: '3g' } })
    expect(lowData()).toBe(true)
    vi.stubGlobal('navigator', { connection: { saveData: true, effectiveType: '4g' } })
    expect(lowData()).toBe(true)
    vi.stubGlobal('navigator', { connection: { effectiveType: '4g' } })
    expect(lowData()).toBe(false)
    vi.stubGlobal('navigator', {})
    expect(lowData()).toBe(false)
  })
})
