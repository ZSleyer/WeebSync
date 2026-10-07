import { useEffect, useId, useRef } from 'react'
import { quietRoute } from './viewTransition'

/**
 * The back gesture closes a layer instead of leaving the page: the layer
 * pushes one history entry while it is open, and popping it - the browser's
 * back button, the swipe from the edge on Android - calls `onBack`. React
 * Router keeps `usr`, `key` and `idx` in the state, so the entry copies them
 * and bumps `idx` rather than replacing the object. Nested layers each hold
 * an entry; back pops the innermost, the outer one still finds its own mark
 * and stays. `guard` is asked first; declining puts the entry back.
 */
export function useBackEntry(onBack: () => void, guard?: () => boolean | Promise<boolean>, enabled = true) {
  const id = useId()
  const guardRef = useRef(guard)
  guardRef.current = guard
  const backRef = useRef(onBack)
  backRef.current = onBack
  const pendingBack = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (!enabled || typeof history === 'undefined') return
    // StrictMode mounts, unmounts and mounts again: the entry from the first
    // pass is still on top, so it is reused rather than pushed twice, and the
    // back() the first cleanup queued is cancelled below before it runs.
    // Chrome resolves history.back() against the entry current at the call,
    // so a back followed by a push would still pop the page's own entry and
    // close the layer the moment it opened.
    clearTimeout(pendingBack.current)
    const mark = history.state?.wsDialog === id ? history.state : { ...history.state, idx: (history.state?.idx ?? 0) + 1, wsDialog: id }
    if (history.state !== mark) history.pushState(mark, '')
    const onPop = async () => {
      if (history.state?.wsDialog === id) return // an inner layer's entry went, not ours
      // the guard declined (unsaved changes): put the entry back
      if (guardRef.current && !(await guardRef.current())) return history.pushState(mark, '')
      backRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // closed, saved or unmounted by its owner while its entry is still on
      // top: take it with us, or the next back is a no-op. After a route
      // change the top entry is the new page's and stays.
      // ponytail: a navigate({replace:true}) while a layer is open wipes the
      // mark and leaves one dead entry behind - one wasted back, never a leave
      pendingBack.current = setTimeout(() => {
        if (history.state?.wsDialog !== id) return
        // the same page, not a navigation: no route transition for it
        quietRoute()
        history.back()
      })
    }
  }, [id, enabled])
}
