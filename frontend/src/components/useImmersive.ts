import { useEffect } from 'react'

/** The root classes of the full-screen media views: the video player and the reader. */
export type ImmersiveKind = 'playing' | 'reading'

/**
 * Marks the root while a full-screen media view is open (`html.playing`,
 * `html.reading`). On a phone the view covers the whole app column, so the
 * shell's bars, the live pill and the mini player step aside under these
 * classes; the routes carry `handle.immersive` for the same reason.
 */
export function useImmersive(kind: ImmersiveKind, on = true) {
  useEffect(() => {
    if (!on) return
    const root = document.documentElement
    root.classList.add(kind)
    return () => root.classList.remove(kind)
  }, [kind, on])
}
