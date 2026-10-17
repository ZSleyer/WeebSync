import { useEffect, useRef, useState } from 'react'

// The platform's close request (Escape, the Android back button or gesture),
// where it exists (Chrome 120+). Not in lib.dom yet.
interface CloseWatcherLike {
  onclose: (() => void) | null
  destroy(): void
}
type CloseWatcherCtor = new () => CloseWatcherLike

/**
 * Lets the back gesture dismiss a transient popup (a menu, a tooltip, a
 * suggestion list) instead of leaving the page. Where the browser has a
 * CloseWatcher it takes the request without a history entry - nothing to
 * clean up when the popup closes some other way, and no dead entry when the
 * popup's own choice navigates. Elsewhere it does nothing: those popups close
 * on a tap outside and on Escape, and a pushed history entry per popup costs
 * more than it earns (see useBackEntry for layers that stay open).
 *
 * Watchers stack: the latest one opened is the first to be asked, so a menu
 * inside a dialog closes before the dialog does.
 */
export function useCloseWatcher(onClose: () => void, enabled = true) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // a watcher is spent by its close request; while the popup is still wanted
  // (the next one down of a stack of menus) a new one takes its place
  const [spent, setSpent] = useState(0)
  useEffect(() => {
    const Ctor = (globalThis as { CloseWatcher?: CloseWatcherCtor }).CloseWatcher
    if (!enabled || !Ctor) return
    let watcher: CloseWatcherLike
    try {
      watcher = new Ctor()
    } catch {
      return // refused (a document that is not fully active)
    }
    watcher.onclose = () => {
      closeRef.current()
      setSpent((n) => n + 1)
    }
    return () => watcher.destroy()
  }, [enabled, spent])
}
