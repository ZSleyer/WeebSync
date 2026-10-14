import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useBack } from './playLinks'

/**
 * The way back from a stacked screen: back through history to wherever it
 * was opened from, or to `to` (the parent) when it was opened by a link with
 * nothing of the app behind it. One look everywhere: the phone's app bar,
 * the desktop title row, a layout's own heading (settings).
 */
export function BackLink({ to, className = '' }: { to: string; className?: string }) {
  const { t } = useTranslation()
  const goBack = useBack(to)
  return (
    <Link
      to={to}
      aria-label={t('nav.back')}
      className={`ws-iconbtn ${className}`}
      onClick={(e) => {
        e.preventDefault()
        goBack()
      }}
    >
      <ArrowLeft aria-hidden />
    </Link>
  )
}
