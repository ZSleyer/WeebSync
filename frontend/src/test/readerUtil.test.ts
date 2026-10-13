import { describe, expect, it } from 'vitest'
import { clampTo, dragOutcome, lookedUrl, volumeOf } from '../pages/readerUtil'

describe('volumeOf', () => {
  it('reads the marked number first', () => {
    expect(volumeOf('One Piece Vol. 05.cbz')).toBe(5)
    expect(volumeOf('Frieren Band 12.cbz')).toBe(12)
    expect(volumeOf('Title v03 (2024) (Digital).cbz')).toBe(3)
    expect(volumeOf('Title Volume 7 [Group].pdf')).toBe(7)
  })
  it('falls back to a lone number, never one in brackets', () => {
    expect(volumeOf('One Piece 105.cbz')).toBe(105)
    expect(volumeOf('[Group] Title - 05 [1080p].cbz')).toBe(5)
    expect(volumeOf('Title (2019).epub')).toBeNull()
    expect(volumeOf('Artbook.cbz')).toBeNull()
  })
})

describe('dragOutcome', () => {
  it('turns past a fifth of the width or on a fast flick', () => {
    expect(dragOutcome(-90, 1000, 400)).toBe('right')
    expect(dragOutcome(90, 1000, 400)).toBe('left')
    expect(dragOutcome(-40, 50, 400)).toBe('right')
  })
  it('springs back on a short slow drag', () => {
    expect(dragOutcome(-40, 1000, 400)).toBeNull()
    expect(dragOutcome(0, 10, 400)).toBeNull()
    expect(dragOutcome(-200, 100, 0)).toBeNull()
  })
})

describe('lookedUrl', () => {
  it('asks for the look in the query', () => {
    const u = lookedUrl('/api/read/b/t/OEBPS/ch%201.xhtml', { size: 21, lead: 1.6, theme: 'sepia', font: 'sans' })
    expect(u).toBe('/api/read/b/t/OEBPS/ch%201.xhtml?look=1&size=21&lead=1.6&theme=sepia&font=sans')
    expect(lookedUrl('/x?a=1', { size: 19, lead: 1.3, theme: 'dark', font: 'serif' })).toContain('/x?a=1&look=1')
  })
  it('keeps stored values inside their range', () => {
    expect(clampTo(40, 15, 26, 19)).toBe(26)
    expect(clampTo(Number.NaN, 15, 26, 19)).toBe(19)
    expect(clampTo(1.6, 1.3, 1.9, 1.6)).toBe(1.6)
  })
})
