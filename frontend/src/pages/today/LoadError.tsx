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
export function LoadError({
  failed,
  onRetry,
}: {
  failed: boolean
  /** resolves to whether the data is still missing, so the outcome never waits on the render */
  onRetry: () => Promise<boolean>
}) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<'idle' | 'busy' | 'ok'>('idle')
  // the prop has caught up with a recovery: a new failure after it starts afresh
  const [settled, setSettled] = useState(false)
  const region = useRef<HTMLDivElement>(null)
  // adjusted while rendering: no effect needed to follow the prop
  if (phase === 'ok') {
    if (!failed && !settled) setSettled(true)
    else if (failed && settled) {
      setPhase('idle')
      setSettled(false)
    }
  }
  useEffect(() => {
    if (phase === 'ok') region.current?.focus()
  }, [phase])
  const retry = async () => {
    if (phase === 'busy') return
    setPhase('busy')
    let again = true
    try {
      again = await onRetry()
    } finally {
      setPhase(again ? 'idle' : 'ok')
    }
  }
  const busy = phase === 'busy'
  // the link stays mounted through a retry, so focus stays on it
  const open = busy || (failed && phase !== 'ok')
  return (
    <div ref={region} role="status" aria-live="polite" tabIndex={-1} className="outline-none">
      {open ? (
        <EmptyState label={busy ? undefined : t('today.loadFailed')}>
          <TextLink tone="accent-2" aria-disabled={busy || undefined} onClick={() => void retry()}>
            {t('today.loadRetry')}
          </TextLink>
          {busy && <span className="sr-only">{t('today.loadRetrying')}</span>}
        </EmptyState>
      ) : (
        phase === 'ok' && <span className="sr-only">{t('today.loadRecovered')}</span>
      )}
    </div>
  )
}
