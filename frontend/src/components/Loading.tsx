import { useTranslation } from 'react-i18next'
import { LoadingIndicator, Skeleton } from 'fluid-lycoris'

// The app's loading indicator: the design system's shape morph, named
// "loading" unless the caller says what. A given label is also shown.
export default function Loading({
  label,
  size = 'md',
  page,
  className,
}: {
  label?: string
  size?: 'sm' | 'md' | 'lg'
  /** the whole page waits on it: it stands in the middle of the free space */
  page?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const indicator = (
    <LoadingIndicator label={label ?? t('app.loading')} showLabel={!!label} size={size} className={className} />
  )
  // sm sits in a line; a section's stands centred where its content will
  // go, a page's in the middle of the screen below the header
  if (page) return <div className="grid min-h-[60dvh] place-items-center">{indicator}</div>
  return size === 'sm' ? indicator : <div className="flex justify-center py-6">{indicator}</div>
}

// name lengths vary like real ones, or the list reads as a pattern
const WIDTHS = [62, 45, 78, 54, 70, 38, 66, 50]

// Rows of a folder listing still on its way, in the listing's own grid, so
// the real rows take their place without a jump. Like the indicator they
// show only once the wait has lasted a moment.
export function SkeletonRows({ full }: { full?: boolean }) {
  const { t } = useTranslation()
  return (
    <ul
      role="status"
      aria-label={t('app.loading')}
      className={`ws-cl-rows t-late animate-pulse ${full ? 'ws-cl-rows--full' : ''}`}
    >
      {WIDTHS.map((w, i) => (
        <li key={i} className="ws-cl-row" aria-hidden>
          <div className="ws-cl-in">
            <span className="ws-cl-glyph">
              <Skeleton shape="block" className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div style={{ width: `${w}%` }}>
                <Skeleton />
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
