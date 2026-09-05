import { useSyncExternalStore } from 'react'

/**
 * Whether a media query matches right now, re-rendering when it changes. Read
 * synchronously on the first render, so a component that mounts one of two
 * layouts (inline buttons or a dialog, a page header or the app bar) never
 * paints the wrong one first and never mounts both.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof matchMedia !== 'function') return () => {}
      const mq = matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
    () => false,
  )
}

/**
 * The width below which a sheet-sized dialog covers the screen. Must match the
 * `dialog.dialog-sheet` media query in the stylesheet. Exported so a page that
 * swaps inline controls for a dialog switches at the same width.
 */
export const SHEET_MQ = '(max-width: 40rem)'
