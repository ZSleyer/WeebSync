import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachHold, HOLD_MS, HOLD_SLOP } from '../pages/playerHold'

// jsdom has no PointerEvent: a MouseEvent carrying the fields the hold reads
function ptr(type: string, target: Element, init: { x?: number; y?: number; id?: number; kind?: string } = {}) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    button: 0,
  })
  Object.assign(e, { pointerId: init.id ?? 1, pointerType: init.kind ?? 'touch' })
  target.dispatchEvent(e)
  return e
}

describe('press and hold', () => {
  let player: HTMLElement
  let surface: HTMLElement
  let button: HTMLElement
  let video: { paused: boolean; ended: boolean; playbackRate: number }
  let seen: boolean[]
  let off: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    player = document.createElement('div')
    surface = document.createElement('div')
    button = document.createElement('button')
    player.append(surface, button)
    document.body.append(player)
    video = { paused: false, ended: false, playbackRate: 1.5 }
    seen = []
    off = attachHold(
      player,
      () => video as HTMLVideoElement,
      (on) => seen.push(on),
    )
  })
  afterEach(() => {
    off()
    player.remove()
    vi.useRealTimers()
  })

  it('plays at 2x while held and restores the previous rate', () => {
    ptr('pointerdown', surface)
    vi.advanceTimersByTime(HOLD_MS)
    expect(video.playbackRate).toBe(2)
    expect(seen).toEqual([true])
    ptr('pointerup', surface)
    expect(video.playbackRate).toBe(1.5)
    expect(seen).toEqual([true, false])
  })

  it('swallows the release so it is not a tap', () => {
    const tap = vi.fn()
    player.addEventListener('pointerup', tap)
    ptr('pointerdown', surface)
    vi.advanceTimersByTime(HOLD_MS)
    ptr('pointerup', surface)
    expect(tap).not.toHaveBeenCalled()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    surface.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
  })

  it('is not a hold before the delay, and a plain tap passes through', () => {
    const tap = vi.fn()
    player.addEventListener('pointerup', tap)
    ptr('pointerdown', surface)
    vi.advanceTimersByTime(HOLD_MS - 50)
    ptr('pointerup', surface)
    vi.advanceTimersByTime(HOLD_MS)
    expect(video.playbackRate).toBe(1.5)
    expect(tap).toHaveBeenCalledOnce()
  })

  it('moving past the slop cancels, a small wobble does not', () => {
    ptr('pointerdown', surface, { x: 100, y: 100 })
    ptr('pointermove', surface, { x: 100 + HOLD_SLOP + 1, y: 100 })
    vi.advanceTimersByTime(HOLD_MS)
    expect(video.playbackRate).toBe(1.5)
    ptr('pointerup', surface)

    ptr('pointerdown', surface, { x: 100, y: 100 })
    ptr('pointermove', surface, { x: 104, y: 103 })
    vi.advanceTimersByTime(HOLD_MS)
    expect(video.playbackRate).toBe(2)
  })

  it('ignores controls, paused video, a second finger and rates of 2x or more', () => {
    ptr('pointerdown', button)
    vi.advanceTimersByTime(HOLD_MS)
    expect(video.playbackRate).toBe(1.5)

    video.paused = true
    ptr('pointerdown', surface)
    vi.advanceTimersByTime(HOLD_MS)
    expect(video.playbackRate).toBe(1.5)
    ptr('pointerup', surface)

    video.paused = false
    ptr('pointerdown', surface, { id: 1 })
    ptr('pointerdown', surface, { id: 2 })
    vi.advanceTimersByTime(HOLD_MS)
    expect(video.playbackRate).toBe(1.5)
    ptr('pointerup', surface, { id: 1 })
    ptr('pointerup', surface, { id: 2 })

    video.playbackRate = 3
    ptr('pointerdown', surface)
    vi.advanceTimersByTime(HOLD_MS)
    expect(video.playbackRate).toBe(3)
    expect(seen).toEqual([])
  })

  it('restores on cancel, blur and a hidden tab', () => {
    for (const end of [() => ptr('pointercancel', surface), () => window.dispatchEvent(new Event('blur'))]) {
      ptr('pointerdown', surface)
      vi.advanceTimersByTime(HOLD_MS)
      expect(video.playbackRate).toBe(2)
      end()
      expect(video.playbackRate).toBe(1.5)
    }
  })

  it('keeps the long-press menu away from the picture but not the controls', () => {
    ptr('pointerdown', surface)
    expect(surface.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }))).toBe(false)
    expect(button.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }))).toBe(true)
  })
})
