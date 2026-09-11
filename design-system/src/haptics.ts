// One short pulse where the platform has a motor. Android fires it, iOS Safari
// has no Vibration API at all and simply ignores the call.
//
// Chrome refuses to vibrate until the document has had a real tap - and a
// gesture that ends in `pointercancel` because the browser took the pointer for
// its own scroll never counts as one. So a page that was reloaded and then only
// scrubbed stays silent, and every blocked call logs its own console warning.
// The activation gate keeps that quiet; the first tap anywhere unlocks the rest
// of the session.
export function haptic(ms: number): boolean {
  try {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return false
    return navigator.vibrate?.(ms) ?? false
  } catch {
    return false // a browser that has the method but refuses the call
  }
}
