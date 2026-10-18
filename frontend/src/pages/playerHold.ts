import { haptic } from 'fluid-lycoris'

// Press and hold on the picture plays at 2x for as long as the finger or
// button stays down (YouTube, Instagram and TikTok all do it). The hold starts
// after HOLD_MS without moving further than HOLD_SLOP, only while playing, and
// puts the rate back exactly as it was on release. The release is swallowed so
// it is not also a tap (controls, play/pause, double-tap seek). A pointer that
// moves first, a second finger or a click on a control is never a hold.
export const HOLD_MS = 450
export const HOLD_SLOP = 10
export const HOLD_RATE = 2

// what keeps its own pointer handling: the bands and cards over the picture,
// the menus and anything that is a control
const CONTROLS =
  '.t-player-dock, .t-player-top, .t-player-menu, .t-player-card, button, a, input, select, [role="button"]'

export function attachHold(player: HTMLElement, video: () => HTMLVideoElement | null, onChange: (on: boolean) => void) {
  let pending: { id: number; x: number; y: number; timer: number } | null = null
  let active: { id: number; prev: number } | null = null
  let swallow = 0
  let touched = 0

  const cancel = () => {
    if (pending) clearTimeout(pending.timer)
    pending = null
  }
  const end = () => {
    cancel()
    if (!active) return
    const v = video()
    if (v) v.playbackRate = active.prev
    active = null
    onChange(false)
  }

  const down = (e: PointerEvent) => {
    if (e.pointerType === 'touch') touched = e.timeStamp
    // a second finger is a pinch, not a hold
    if (pending || active) return cancel()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (!(e.target instanceof Element) || e.target.closest(CONTROLS)) return
    const id = e.pointerId
    const timer = window.setTimeout(() => {
      pending = null
      const v = video()
      // a rate the user already set to 2x or more is left alone
      if (!v || v.paused || v.ended || v.playbackRate >= HOLD_RATE) return
      active = { id, prev: v.playbackRate }
      v.playbackRate = HOLD_RATE
      onChange(true)
      haptic(10)
    }, HOLD_MS)
    pending = { id, x: e.clientX, y: e.clientY, timer }
  }
  const move = (e: PointerEvent) => {
    if (pending?.id === e.pointerId && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > HOLD_SLOP) cancel()
  }
  const up = (e: PointerEvent) => {
    if (pending?.id === e.pointerId) cancel()
    if (active?.id !== e.pointerId) return
    end()
    if (e.type === 'pointerup' && e.target instanceof Node && player.contains(e.target)) {
      e.stopPropagation()
      swallow = e.timeStamp
    }
  }
  const click = (e: MouseEvent) => {
    if (swallow && e.timeStamp - swallow < 400) {
      e.stopPropagation()
      e.preventDefault()
    }
    swallow = 0
  }
  // the long-press menu of a touch screen must not open over the hold
  const menu = (e: Event) => {
    if (
      (pending || active || e.timeStamp - touched < 1000) &&
      e.target instanceof Element &&
      !e.target.closest(CONTROLS)
    ) {
      e.preventDefault()
    }
  }
  const hidden = () => document.hidden && end()

  player.addEventListener('pointerdown', down, true)
  player.addEventListener('click', click, true)
  player.addEventListener('contextmenu', menu)
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
  window.addEventListener('blur', end)
  document.addEventListener('visibilitychange', hidden)
  return () => {
    end()
    player.removeEventListener('pointerdown', down, true)
    player.removeEventListener('click', click, true)
    player.removeEventListener('contextmenu', menu)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', up, true)
    window.removeEventListener('blur', end)
    document.removeEventListener('visibilitychange', hidden)
  }
}
