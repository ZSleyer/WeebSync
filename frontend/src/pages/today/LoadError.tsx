import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, TextLink } from 'fluid-lycoris'

/**
 * What a list says when its data could not be read: not "nothing here", which
 * would claim an answer the server never gave. One way to try again.
 *
 * The live region stays mounted, so the first failure is announced as well as
 * what a retry brings: "trying again" while it runs (which also lets a second
 * identical failure be announced anew), the failure, or the recovery. On
 * recovery the retry button is gone, so focus moves to the region instead of
 * dropping to the page.
 */
export function LoadError({ failed, onRetry }: { failed: boolean; onRetry: () => unknown }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const region = useRef<HTMLDivElement>(null)
  const recovered = tried && !failed && !busy
  useEffect(() => {
    if (recovered) region.current?.focus()
  }, [recovered])
  const retry = async () => {
    setTried(true)
    setBusy(true)
    try {
      await onRetry()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div ref={region} role="status" aria-live="polite" tabIndex={-1} className="outline-none">
      {busy ? (
        <span className="sr-only">{t('today.loadRetrying')}</span>
      ) : failed ? (
        <EmptyState label={t('today.loadFailed')}>
          <TextLink tone="accent-2" onClick={() => void retry()}>
            {t('today.loadRetry')}
          </TextLink>
        </EmptyState>
      ) : (
        recovered && <span className="sr-only">{t('today.loadRecovered')}</span>
      )}
    </div>
  )
}
