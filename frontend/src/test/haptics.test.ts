import { describe, expect, it, vi, afterEach } from 'vitest'
import { haptic } from '@weebsync/design-system'

const patch = (v: unknown, activation?: { hasBeenActive: boolean }) => {
  Object.defineProperty(navigator, 'vibrate', { value: v, configurable: true })
  Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true })
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'vibrate')
  Reflect.deleteProperty(navigator, 'userActivation')
})

describe('haptic', () => {
  it('pulses once the document has had a tap', () => {
    const spy = vi.fn(() => true)
    patch(spy, { hasBeenActive: true })
    expect(haptic(8)).toBe(true)
    expect(spy).toHaveBeenCalledWith(8)
  })

  // Chrome refuses to vibrate before the first tap and logs a warning for
  // every blocked call - after a reload the band would tick per day scrubbed
  it('stays quiet before the first tap, instead of being refused per tick', () => {
    const spy = vi.fn(() => true)
    patch(spy, { hasBeenActive: false })
    expect(haptic(3)).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('survives a platform without the API', () => {
    patch(undefined, { hasBeenActive: true })
    expect(haptic(8)).toBe(false)
    patch(() => {
      throw new Error('refused')
    }, { hasBeenActive: true })
    expect(haptic(8)).toBe(false)
  })
})
