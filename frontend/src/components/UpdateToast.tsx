import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMatches } from 'react-router'
import { Button } from 'fluid-lycoris'
import { assetRefs } from './assetRefs'

// A deploy swaps the hashed bundles under a tab that is still open: lazy
// routes 404 and the API answers in a shape the old code does not know. The
// document that is served now is compared against the one this tab booted
// from; a difference means a new build is out and the tab offers a reload.

const CHECK_EVERY = 5 * 60_000 // background poll
const FOCUS_GAP = 60_000 // no re-check within a minute of the last one
const SNOOZE = 10 * 60_000 // "later" keeps the toast away this long
const COUNTDOWN = 60 // seconds until the automatic reload

// Read once, when the bundle runs, not when the toast mounts: the toast drops
// out of the shell on a phone's full-screen player and back, and by then Vite
// has added the lazy screens' preload and stylesheet links to <head>, which
// the served document never lists. The snooze outlives a remount the same way
const booted = assetRefs(document).join('\n')
let snoozedUntil = 0

// Whether a reload would throw something away. Controlled inputs keep their
// value attribute in step with the typed text (React writes it), so
// value !== defaultValue finds nothing here. Two signals do: the focus is in
// a field that takes text, and a dirty form has armed a beforeunload guard
// (UnsavedGuard, WatchDialog), which a probe event asks without leaving. Playing media counts too.
export function editing(): boolean {
  const el = document.activeElement
  if (el instanceof HTMLElement) {
    if (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
    if (
      el instanceof HTMLInputElement &&
      !/^(button|submit|reset|checkbox|radio|range|image|file|color)$/.test(el.type)
    )
      return true
  }
  // a reload ends playback: the player page and the mini player
  const playing = (m: Element) => m instanceof HTMLMediaElement && !m.paused && !m.ended
  if (Array.from(document.querySelectorAll('video, audio')).some(playing)) return true
  const probe = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(probe)
  return probe.defaultPrevented
}

export default function UpdateToast() {
  const { t } = useTranslation()
  const [stale, setStale] = useState(false)
  const [left, setLeft] = useState(COUNTDOWN)
  const lastCheck = useRef(0)
  // the player and the viewer (App.tsx marks them `immersive`): reading or a
  // paused video holds state no reload may drop, wide screen or not - the
  // toast stays, the reload is the user's to press
  const immersive = useMatches().some((m) => (m.handle as { immersive?: boolean } | undefined)?.immersive)
  // the countdown restarts with every new alarm, not with every render
  const arm = () => {
    setLeft(COUNTDOWN)
    setStale(true)
  }

  useEffect(() => {
    let alive = true
    const check = async () => {
      if (Date.now() < snoozedUntil || document.hidden) return
      lastCheck.current = Date.now()
      try {
        const res = await fetch('/index.html', { cache: 'no-store', headers: { Accept: 'text/html' } })
        if (!res.ok) return
        const html = await res.text()
        const now = assetRefs(new DOMParser().parseFromString(html, 'text/html')).join('\n')
        // an empty list is a login page or an error page, not a build
        if (alive && now && now !== booted) arm()
      } catch {
        /* offline or mid-restart: the next check will tell */
      }
    }
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastCheck.current > FOCUS_GAP) check()
    }
    // a chunk that would not load may belong to a build a deploy replaced, or
    // the connection dropped: ask the document which. The import still fails
    // and the screen's own error page takes it (App.tsx); held back, it would
    // resolve to nothing and fail somewhere less clear
    const onPreloadError = () => void check()
    const timer = setInterval(check, CHECK_EVERY)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('vite:preloadError', onPreloadError)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('vite:preloadError', onPreloadError)
    }
  }, [])

  useEffect(() => {
    if (!stale) return
    // the countdown starts over while there is input a reload would lose
    const tick = setInterval(() => setLeft((s) => (immersive || editing() ? COUNTDOWN : s - 1)), 1000)
    return () => clearInterval(tick)
  }, [stale, immersive])

  useEffect(() => {
    if (stale && left <= 0 && !immersive && !editing()) window.location.reload()
  }, [stale, left, immersive])

  if (!stale) return null
  return (
    <div
      role="status"
      aria-live="polite"
      // a shell row above the tab bar on a phone (a fixed box drifts on
      // Firefox for Android while the URL bar animates), a corner card on a
      // desktop where the document scrolls
      className="t-panel t-pop t-pop--up flex flex-col gap-3 border border-accent/60 bg-bg-secondary p-4 lg:fixed! lg:right-6 lg:bottom-6 lg:z-50 lg:max-w-sm lg:shadow-lg"
    >
      <p className="text-sm text-t-primary">{t('app.updateAvailable')}</p>
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs text-t-muted" aria-live="off">
          {t('app.reloadIn', { s: Math.max(left, 0) })}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              snoozedUntil = Date.now() + SNOOZE
              setStale(false)
            }}
          >
            {t('app.later')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => window.location.reload()}>
            {t('app.reloadNow')}
          </Button>
        </div>
      </div>
    </div>
  )
}
