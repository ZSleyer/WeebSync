import { useId } from 'react'
import { LOGO_H, LOGO_PATH_S, LOGO_PATH_W, LOGO_W } from '../logo'

// The mark inline, so the S follows the accent live and the W the text
// colour. Decorative: whatever wraps it names the destination. While
// something downloads (active) a sheen crosses the S every few seconds, the
// mark as a status light; idle, or with motion off, it stands still.
export default function Logo({ className = '', active = false }: { className?: string; active?: boolean }) {
  const id = useId()
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${LOGO_W} ${LOGO_H}`}
      className={`t-logo ${className}`}
      data-active={active || undefined}
    >
      <path d={LOGO_PATH_W} fill="currentColor" />
      <path d={LOGO_PATH_S} fill="var(--accent-blue)" />
      {active && (
        <>
          <defs>
            <clipPath id={`${id}s`}>
              <path d={LOGO_PATH_S} />
            </clipPath>
            <linearGradient id={`${id}g`} x1="0" x2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0" />
              <stop offset=".5" stopColor="#fff" stopOpacity=".55" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g clipPath={`url(#${id}s)`}>
            <g transform="skewX(-20)">
              <rect className="t-logo-sheen" width="220" height={LOGO_H} fill={`url(#${id}g)`} />
            </g>
          </g>
        </>
      )}
    </svg>
  )
}
