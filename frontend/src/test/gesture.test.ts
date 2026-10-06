import { describe, expect, it } from 'vitest'
import { moveVelocity, project, releaseVelocity, startVelocity, throwMs } from '@weebsync/design-system'

describe('gesture', () => {
  it('reads the speed over the last window, not the whole gesture', () => {
    const v = startVelocity(0, 0)
    moveVelocity(v, 100, 50)
    // the anchor is older than the window: it moves to the current point
    moveVelocity(v, 110, 400)
    moveVelocity(v, 130, 410)
    expect(releaseVelocity(v, 130, 420)).toBe(1)
  })

  // the release repeats the last move's position: a window that restarted on
  // that move must not read the flick as a drop
  it('keeps the speed when the window restarts on the last move', () => {
    const v = startVelocity(0, 0)
    for (let t = 16; t <= 112; t += 16) moveVelocity(v, t * 2, t)
    expect(releaseVelocity(v, 224, 112)).toBe(2)
  })

  it('throws nothing when the hand rested before letting go', () => {
    const v = startVelocity(0, 0)
    moveVelocity(v, 80, 20)
    expect(releaseVelocity(v, 80, 300)).toBe(0)
  })

  it('never divides by a timestamp gap of nothing', () => {
    const v = startVelocity(0, 0)
    moveVelocity(v, 40, 0)
    expect(releaseVelocity(v, 40, 0)).toBe(5)
  })

  it('projects a throw and times it from the remaining distance', () => {
    expect(project(100, 1)).toBe(300)
    expect(throwMs(100, 0.01)).toBeNull()
    expect(throwMs(100, 1.5)).toBe(200)
    expect(throwMs(10, 5)).toBe(180)
    expect(throwMs(1000, 0.5)).toBe(340)
  })
})
