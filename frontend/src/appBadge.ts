import { useEffect } from 'react'

type Badging = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }

/**
 * Mirrors a count onto the installed app's icon (Badging API). Feature
 * detected; a failure (no permission, not installed) is nothing to report.
 */
export function setAppBadge(count: number) {
  const nav = navigator as Badging
  try {
    const p = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.()
    p?.catch(() => {})
  } catch {
    /* unsupported or refused */
  }
}

/** Keeps the badge at `count`. It stays when the screen unmounts: it belongs to the app, not the page. */
export function useAppBadge(count: number) {
  useEffect(() => setAppBadge(count), [count])
}
