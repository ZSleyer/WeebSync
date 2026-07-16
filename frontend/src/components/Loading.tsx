import { useTranslation } from 'react-i18next'

// Tempest-style loading indicator: three staggered pulsing bars + label.
// Motion is globally gated via [data-motion="off"] / prefers-reduced-motion.
export default function Loading({ label, className = '' }: { label?: string; className?: string }) {
  const { t } = useTranslation()
  return (
    <div className={`flex items-center gap-2.5 ${className}`} role="status">
      <span aria-hidden className="flex h-4 items-end gap-1">
        <span className="t-load-bar" />
        <span className="t-load-bar" />
        <span className="t-load-bar" />
      </span>
      <span className="t-label">{label ?? t('app.loading')}</span>
    </div>
  )
}

// Skeleton placeholders shaped like the media card lists they stand in for.
export function SkeletonCards({ count = 3, className = '' }: { count?: number; className?: string }) {
  const { t } = useTranslation()
  return (
    <div role="status" aria-label={t('app.loading')} className={`grid grid-cols-1 gap-3 ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="t-panel flex animate-pulse gap-4 p-4" aria-hidden>
          <div className="t-hatch h-24 w-16 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2.5 py-1">
            <div className="h-3.5 w-2/3 bg-bg-hover" />
            <div className="h-3 w-1/3 bg-bg-hover" />
            <div className="h-3 w-1/2 bg-bg-hover" />
          </div>
        </div>
      ))}
    </div>
  )
}
