import { useEffect, useId, useRef } from 'react'
import { quietRoute } from './viewTransition'

// The layers holding an entry, bottom first, and those whose owner let go this
// tick. Layers that close together (a dialog and the folder steps of a picker
// inside it) take their entries with one history step, whatever order React
// ran their cleanups in: a layer asking on its own would find another's entry
// on top and give up, leaving the rest behind.
const live: { id: string; idx: number }[] = []
const leaving = new Set<string>()
let flushing: ReturnType<typeof setTimeout> | undefined

function flush() {
  flushing = undefined
  let n = 0
  // only entries still on top of the history are ours to take: after a route
  // change the top entry is the new page's and stays. Layers count while
  // their entries follow one another (idx), so one that lost its entry on the
  // way - popped, or wiped by a replace - is not taken for a neighbour.
  const top = live[live.length - 1]
  if (top && leaving.has(top.id) && history.state?.wsDialog === top.id) {
    let idx = top.idx + 1
    while (live.length && leaving.has(live[live.length - 1].id) && live[live.length - 1].idx === idx - 1) {
      idx = (live.pop() as { idx: number }).idx
      n++
    }
  }
  // those gone with their entry already (popped, or left behind)
  for (let i = live.length - 1; i >= 0; i--) if (leaving.has(live[i].id)) live.splice(i, 1)
  leaving.clear()
  if (n === 0) return
  // the same page, not a navigation: no route transition for it
  quietRoute()
  if (n === 1) history.back()
  else history.go(-n)
}

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
  useEffect(() => {
    if (!enabled || typeof history === 'undefined') return
    // StrictMode mounts, unmounts and mounts again: the entry from the first
    // pass is still on top, so it is reused rather than pushed twice, and the
    // step back the first cleanup queued is called off here before it runs.
    // Chrome resolves history.back() against the entry current at the call,
    // so a back followed by a push would still pop the page's own entry and
    // close the layer the moment it opened.
    leaving.delete(id)
    const mark =
      history.state?.wsDialog === id
        ? history.state
        : { ...history.state, idx: (history.state?.idx ?? 0) + 1, wsDialog: id }
    if (history.state !== mark) history.pushState(mark, '')
    if (!live.some((l) => l.id === id)) live.push({ id, idx: mark.idx ?? 0 })
    const onPop = async () => {
      // an inner layer's entry went, not ours: ours or a newer one is still
      // the current entry (a layer two levels down leaves the middle one's)
      if (history.state?.wsDialog === id || (history.state?.idx ?? 0) > (mark.idx ?? 0)) return
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
      leaving.add(id)
      clearTimeout(flushing)
      flushing = setTimeout(flush)
    }
  }, [id, enabled])
}

/**
 * Runs `fn` once the history step of a layer that was just closed has landed.
 * Closing takes its entry with history.back(), which Chrome resolves against
 * the entry current at the call: a navigation pushed in between is discarded
 * when the pop arrives. So an action that follows `onClose()` and navigates
 * waits for the popstate first. Without a layer's entry on top there is
 * nothing to wait for. The timeout covers a close that takes no step (the
 * entry was left behind after a route change, or the step was refused).
 */
export function afterBackEntry(fn: () => void, timeout = 400) {
  if (typeof history === 'undefined' || !history.state?.wsDialog) return fn()
  let done = false
  const run = () => {
    if (done) return
    done = true
    window.removeEventListener('popstate', onPop)
    clearTimeout(fallback)
    fn()
  }
  // after the router has handled the pop
  const onPop = () => setTimeout(run)
  const fallback = setTimeout(run, timeout)
  window.addEventListener('popstate', onPop, { once: true })
}
