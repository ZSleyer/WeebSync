import { useEffect, useEffectEvent, useRef, type RefObject } from 'react'
import type { LucideProps } from 'lucide-react'

// Two navigation icons drawn in lucide's grid with a moving part, played as
// their page becomes the current one: the house's door swings out on its
// hinge and shuts again, the folder's front tips open and stays open while
// the page is current. Lucide's own House and Folder are one path each and
// can't do that. The parts morph their outline with SVG <animate>, which
// every engine runs (WebKit can't animate the CSS d property).

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

// the leaf of the door, shut in its frame and swung out past the hinge
// (x 15): the free edge comes round to the right and stands taller, nearer
// the eye
const SHUT = 'M9 21L9 12L15 12L15 21'
const OUT = 'M17.6 21.6L17.6 10.4L15 12L15 21'

export function HouseIcon(props: LucideProps) {
  const ref = useRef<SVGSVGElement>(null)
  const swing = useRef<SVGAnimationElement>(null)
  const show = useRef<SVGAnimationElement>(null)
  useCurrent(ref, (current, first) => {
    // once, on the way in; at rest the house is the plain sign
    if (!current || first || still()) return
    swing.current?.beginElement()
    show.current?.beginElement()
  })
  return (
    <svg ref={ref} {...svg(props)}>
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d={SHUT} opacity="0">
        <animate
          ref={swing}
          attributeName="d"
          values={`${SHUT};${OUT};${OUT};${SHUT}`}
          keyTimes="0;0.38;0.62;1"
          calcMode="spline"
          keySplines="0.3 0 0.2 1;0 0 1 1;0.4 0 0.6 1"
          dur="0.65s"
          begin="indefinite"
        />
        <animate
          ref={show}
          attributeName="opacity"
          values="0;1;1;0"
          keyTimes="0;0.1;0.9;1"
          dur="0.65s"
          begin="indefinite"
        />
      </path>
    </svg>
  )
}

// the folder's front panel, flat against the back and tipped towards the
// eye: its top edge drops and widens, the bottom stays put
const FLAT = 'M2 6L22 6L22 18A2 2 0 0 1 20 20L4 20A2 2 0 0 1 2 18Z'
const TIPPED = 'M0.6 9.4L23.4 9.4L22 18A2 2 0 0 1 20 20L4 20A2 2 0 0 1 2 18Z'

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
