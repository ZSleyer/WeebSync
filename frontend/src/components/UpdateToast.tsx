import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@weebsync/design-system'
import { assetRefs } from './assetRefs'

// A deploy swaps the hashed bundles under a tab that is still open: lazy
// routes 404 and the API answers in a shape the old code does not know. The
// document that is served now is compared against the one this tab booted
// from; a difference means a new build is out and the tab offers a reload.

const CHECK_EVERY = 5 * 60_000 // background poll
const FOCUS_GAP = 60_000 // no re-check within a minute of the last one
const SNOOZE = 10 * 60_000 // "later" keeps the toast away this long
const COUNTDOWN = 60 // seconds until the automatic reload

export default function UpdateToast() {
  const { t } = useTranslation()
  const [stale, setStale] = useState(false)
  const [left, setLeft] = useState(COUNTDOWN)
  const booted = useRef(assetRefs(document).join('\n'))
  const lastCheck = useRef(0)
  const snoozedUntil = useRef(0)
  // the countdown restarts with every new alarm, not with every render
  const arm = () => {
    setLeft(COUNTDOWN)
    setStale(true)
  }

  useEffect(() => {
    let alive = true
    const check = async () => {
      if (Date.now() < snoozedUntil.current || document.hidden) return
      lastCheck.current = Date.now()
      try {
        const res = await fetch('/index.html', { cache: 'no-store', headers: { Accept: 'text/html' } })
        if (!res.ok) return
        const html = await res.text()
        const now = assetRefs(new DOMParser().parseFromString(html, 'text/html')).join('\n')
        // an empty list is a login page or an error page, not a build
        if (alive && now && now !== booted.current) arm()
      } catch {
        /* offline or mid-restart: the next check will tell */
      }
    }
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastCheck.current > FOCUS_GAP) check()
    }
    // a chunk that is gone is the surest sign: the build it belonged to is
    const onPreloadError = (e: Event) => {
      e.preventDefault()
      arm()
    }
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
    const tick = setInterval(() => setLeft((s) => s - 1), 1000)
    return () => clearInterval(tick)
  }, [stale])

  useEffect(() => {
    if (stale && left <= 0) window.location.reload()
  }, [stale, left])

  if (!stale) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="t-panel fixed! inset-x-3 bottom-[calc(var(--nav-h,0px)+0.75rem)] z-50 flex flex-col gap-3 border border-accent/60 bg-bg-secondary p-4 shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4 sm:max-w-sm"
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
              snoozedUntil.current = Date.now() + SNOOZE
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
