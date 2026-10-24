import { useTranslation } from 'react-i18next'
import { EmptyState, TextLink } from 'fluid-lycoris'

/**
 * What a list says when its data could not be read: not "nothing here", which
 * would claim an answer the server never gave. One way to try again.
 */
export function LoadError({ onRetry, inline }: { onRetry: () => void; inline?: boolean }) {
  const { t } = useTranslation()
  return (
    <EmptyState inline={inline} label={t('today.loadFailed')}>
      <TextLink tone="accent-2" onClick={onRetry}>
        {t('today.loadRetry')}
      </TextLink>
    </EmptyState>
  )
}
