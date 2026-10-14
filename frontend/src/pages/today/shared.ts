import { useEffect, useRef, useState } from 'react'
import { enterPage } from 'fluid-lycoris'
import type { Watch } from '../../api'

/** what a watch hands the title card: its record, and itself as the watch to list first */
export const seriesTarget = (w: Watch) => ({
  source: w.mediaSource,
  id: w.media!.id,
  media: w.media,
  watchId: w.id,
  title: w.titleOverride || undefined,
})

/**
 * False for the render that mounts the page, true a frame later: what lies
 * below the first screen mounts in its own render after the first paint, so
 * entering the page is not one long task. Not a transition: a sliced render
 * could miss the shell's entry, which reads the boxes two frames after the
 * mount; this one is in place by then and rises with the rest.
 */
export function useAfterFirstPaint() {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setLate(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return late
}

/** how long a rise plays before its mark comes off, so rows mounted later by a poll do not rise again */
const RISE_MS = 1200

/**
 * The rise for content that arrives after the page was entered: the shell's
 * entry played on the skeletons, so when the real rows land the block under
 * `ref` rises once (after its first paint). Content already there on the
 * first render was part of the shell's entry and does not rise twice.
 */
export function useRiseOnData(ref: { current: HTMLElement | null }, ready: boolean) {
  const readyAtMount = useRef(ready)
  const played = useRef(false)
  useEffect(() => {
    if (!ready || readyAtMount.current || played.current) return
    played.current = true
    let b = 0
    let id: ReturnType<typeof setTimeout> | undefined
    const a = requestAnimationFrame(() => {
      b = requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        enterPage(el)
        id = setTimeout(() => el.removeAttribute('data-wipe'), RISE_MS)
      })
    })
    return () => {
      cancelAnimationFrame(a)
      cancelAnimationFrame(b)
      clearTimeout(id)
    }
  }, [ready, ref])
}
