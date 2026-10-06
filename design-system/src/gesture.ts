// What a released finger was doing, and how the element it let go of should
// carry on. Shared by the gestures that throw something: the bottom sheet, the
// day band's fling, the row swipe.

// Speed is measured over a window, never from the last event delta: the browser
// decides how often it reports a move, and a single 2ms gap would read as a
// throw of any speed. A hand that rested longer than this before letting go
// throws nothing.
export const VELOCITY_MS = 100

// A throw is read as where it would have come to rest: the release position
// plus this much more travel at the release speed. The nearest resting place
// to that point wins, so a fast short flick and a slow long pull agree.
export const PROJECT_MS = 200

// The curve a thrown element finishes on. It starts with a slope of 3, so a
// duration of 3 x distance / speed begins at exactly the finger's speed - no
// hitch where a fixed ease-in would first slow the element down.
export const EASE_THROW = 'cubic-bezier(0.25, 0.75, 0.4, 1)'
const THROW_MIN = 180
const THROW_MAX = 340
// below this (px/ms) the release counts as a drop, not a throw
const STILL = 0.05

/** A running speed measurement along one axis. */
export interface Velocity {
  /** anchor position and time: where the window starts */
  p: number
  t: number
  /** the last move: position and time */
  lp: number
  lt: number
}

export const startVelocity = (p: number, now = performance.now()): Velocity => ({ p, t: now, lp: p, lt: now })

/**
 * Record a move; once the anchor is older than the window it moves up to the
 * move before this one - not to this one, or a reset on the last move would
 * sit exactly where the finger lets go and read a flick as a drop.
 */
export function moveVelocity(v: Velocity, p: number, now = performance.now()) {
  if (now - v.t > VELOCITY_MS) {
    v.p = v.lp
    v.t = v.lt
  }
  v.lp = p
  v.lt = now
}

/** px/ms at release, signed; 0 when the hand rested before letting go. */
export function releaseVelocity(v: Velocity, p: number, now = performance.now()): number {
  if (now - v.lt > VELOCITY_MS) return 0
  // two events with the same timestamp say nothing about speed
  return (p - v.p) / Math.max(now - v.t, 8)
}

/** Where a throw from `pos` at `v` would come to rest. */
export const project = (pos: number, v: number) => pos + v * PROJECT_MS

/** How long a thrown element takes over `distance`, or null for a drop. */
export function throwMs(distance: number, v: number): number | null {
  if (Math.abs(v) < STILL) return null
  return Math.min(THROW_MAX, Math.max(THROW_MIN, (3 * Math.abs(distance)) / Math.abs(v)))
}
