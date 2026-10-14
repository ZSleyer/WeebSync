import type { LucideProps } from 'lucide-react'

// Two navigation icons drawn in lucide's grid with a moving part, so the
// current page can open them (.t-nav-door, .t-nav-flap in index.css): the
// house's door swings in on its hinge, the folder's front tips open. Lucide's
// own House and Folder are one path each and can't do that.

const base = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

// lucide's props, so the two sit wherever a lucide icon does
const svg = ({ size = 24, absoluteStrokeWidth: _, ...rest }: LucideProps) => ({
  ...base,
  width: size,
  height: size,
  ...rest,
})

export function HouseIcon(props: LucideProps) {
  return (
    <svg {...svg(props)}>
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <rect className="t-nav-doorway" x="9" y="12" width="6" height="9" fill="currentColor" stroke="none" />
      <path className="t-nav-door" d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
    </svg>
  )
}

export function FolderIcon(props: LucideProps) {
  return (
    <svg {...svg(props)}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <path className="t-nav-flap" d="M2 11h20v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
    </svg>
  )
}
