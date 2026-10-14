import { useEffect, useEffectEvent, useRef, type CSSProperties, type RefObject } from 'react'
import type { LucideProps } from 'lucide-react'

// Two navigation icons drawn in lucide's grid with moving parts, played as
// their page becomes the current one: the dashboard's tiles grow in one by
// one, the folder's front swings open and stays open while the page is
// current. Lucide's own icons are one piece and can't do that. The folder
// morphs its outline with SVG <animate>, which every engine runs (WebKit
// can't animate the CSS d property).

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

const still = () =>
  document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches

/** Calls onChange(current) whenever the icon's link becomes or stops being the current page. */
function useCurrent(ref: RefObject<SVGSVGElement | null>, onChange: (current: boolean, first: boolean) => void) {
  const changed = useEffectEvent(onChange)
  useEffect(() => {
    const link = ref.current?.closest('a')
    if (!link) return
    let was = link.getAttribute('aria-current') === 'page'
    changed(was, true)
    const mo = new MutationObserver(() => {
      const now = link.getAttribute('aria-current') === 'page'
      if (now !== was) changed(now, false)
      was = now
    })
    mo.observe(link, { attributes: true, attributeFilter: ['aria-current'] })
    return () => mo.disconnect()
  }, [ref])
}

/** Plays an <animate>; with motion off it lands on its last frame at once. */
function play(a: SVGAnimationElement | null) {
  if (!a) return
  if (still()) a.beginElementAt(-10)
  else a.beginElement()
}

// Heute's sign: lucide's dashboard grid, the tiles growing in one after
// the other as the page becomes current (.t-nav-tile in index.css)
const TILES = [
  { x: 3, y: 3, h: 9 },
  { x: 14, y: 3, h: 5 },
  { x: 14, y: 12, h: 9 },
  { x: 3, y: 16, h: 5 },
]

export function DashboardIcon(props: LucideProps) {
  return (
    <svg {...svg(props)}>
      {TILES.map((r, i) => (
        <rect
          key={i}
          className="t-nav-tile"
          style={{ '--i': i } as CSSProperties}
          width="7"
          height={r.h}
          x={r.x}
          y={r.y}
          rx="1"
        />
      ))}
    </svg>
  )
}

// the folder's front panel, flat against the back and swung open: the top
// edge drops and slides forward, so the panel stands slanted over its fixed
// bottom, the open folder of every icon set (Material folder_open)
const FLAT = 'M2 6L22 6L22 18A2 2 0 0 1 20 20L4 20A2 2 0 0 1 2 18Z'
const TIPPED = 'M6.4 10L23.4 10L21.1 18.5A2 2 0 0 1 19.2 20L4 20A2 2 0 0 1 2 18Z'

export function FolderIcon(props: LucideProps) {
  const ref = useRef<SVGSVGElement>(null)
  const open = useRef<SVGAnimationElement>(null)
  const close = useRef<SVGAnimationElement>(null)
  useCurrent(ref, (current, first) => {
    if (first && !current) return
    play(current ? open.current : close.current)
  })
  const morph = {
    attributeName: 'd',
    dur: '0.26s',
    begin: 'indefinite',
    fill: 'freeze',
    calcMode: 'spline',
    keyTimes: '0;1',
    keySplines: '0.3 0 0.2 1',
  } as const
  return (
    <svg ref={ref} {...svg(props)}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <path d={FLAT}>
        <animate ref={open} {...morph} values={`${FLAT};${TIPPED}`} />
        <animate ref={close} {...morph} values={`${TIPPED};${FLAT}`} />
      </path>
    </svg>
  )
}
