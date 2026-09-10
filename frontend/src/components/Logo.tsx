import { LOGO_H, LOGO_PATH_S, LOGO_PATH_W, LOGO_W } from '../logo'

// The mark inline, so the S follows the accent live and the W the text
// colour. Decorative: whatever wraps it names the destination.
export default function Logo({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden viewBox={`0 0 ${LOGO_W} ${LOGO_H}`} className={className}>
      <path d={LOGO_PATH_W} fill="currentColor" />
      <path d={LOGO_PATH_S} fill="var(--accent-blue)" />
    </svg>
  )
}
