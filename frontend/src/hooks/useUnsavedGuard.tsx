import { useEffect } from 'react'
import { useBlocker } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../components/ConfirmModal'

// Blocks navigation away from a form with unsaved changes: react-router's
// useBlocker covers in-app navigation, a beforeunload listener covers tab
// close / reload. When a blocked navigation is pending it shows the custom
// "discard changes?" modal instead of the browser-native prompt.
export function UnsavedGuard({ dirty }: { dirty: boolean }) {
  const { t } = useTranslation()
  const blocker = useBlocker(dirty)

  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  if (blocker.state !== 'blocked') return null
  return (
    <ConfirmModal
      destructive
      title={t('common.unsavedTitle')}
      message={t('common.unsavedMsg')}
      confirmLabel={t('common.discard')}
      cancelLabel={t('common.keepEditing')}
      onConfirm={() => blocker.proceed?.()}
      onCancel={() => blocker.reset?.()}
    />
  )
}
