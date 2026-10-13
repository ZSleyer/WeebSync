import { beforeEach, describe, expect, it } from 'vitest'
import { markSeen, resumeFrom, savedPosition, storePosition, wasSeen } from '../pages/playPosition'

describe('playPosition', () => {
  beforeEach(() => localStorage.clear())

  it('offers to resume only away from both ends', () => {
    expect(resumeFrom(1, 1400)).toBeNull()
    expect(resumeFrom(754, 1400)).toBe(754)
    expect(resumeFrom(1399, 1400)).toBeNull()
    expect(resumeFrom(30, 0)).toBe(30)
  })

  it('remembers a position per server and path', () => {
    storePosition(1, '/a.mkv', 120, 1400)
    expect(savedPosition(1, '/a.mkv')).toBe(120)
    expect(savedPosition(2, '/a.mkv')).toBe(0)
  })

  it('forgets the position at the end but keeps it seen', () => {
    storePosition(1, '/a.mkv', 120, 1400)
    markSeen(1, '/a.mkv')
    storePosition(1, '/a.mkv', 1399, 1400)
    expect(savedPosition(1, '/a.mkv')).toBe(0)
    expect(wasSeen(1, '/a.mkv')).toBe(true)
    expect(wasSeen(1, '/b.mkv')).toBe(false)
  })

  it('survives broken storage', () => {
    localStorage.setItem('weebsync.player.pos', '[1,2')
    expect(savedPosition(1, '/a.mkv')).toBe(0)
    storePosition(1, '/a.mkv', 60, 0)
    expect(savedPosition(1, '/a.mkv')).toBe(60)
  })
})
