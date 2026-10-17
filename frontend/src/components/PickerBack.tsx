import { useEffect, useRef, useState } from 'react'
import { useBackEntry } from 'fluid-lycoris'

const segs = (p: string) => p.split('/').filter(Boolean)

/** How many folders `path` lies below `start` (0 when it is the start or elsewhere). */
export function stepsBelow(start: string, path: string): number {
  const a = segs(start)
  const b = segs(path)
  return a.every((s, i) => b[i] === s) ? b.length - a.length : 0
}

/** `path` cut back to `depth` folders below `start`. */
export function pathAtDepth(start: string, path: string, depth: number): string {
  const s = segs(start).length
  return (
    (start.startsWith('/') ? '/' : '') +
    segs(path)
      .slice(0, s + depth)
      .join('/')
  )
}

function Step({ onBack }: { onBack: () => void }) {
  useBackEntry(onBack)
  return null
}

/**
 * The back gesture for a folder picker that opens inside a dialog (or a
 * page): while the picker stands below the folder it opened at, each folder
 * is a history entry, and back goes up one folder - the dialog only closes
 * from the start folder. Mount it with the picker; the folder it opens at is
 * the start. Folders left by the picker's own controls give their entries
 * back, and so does closing the dialog, in one step.
 */
export default function PickerBack({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const [start] = useState(path)
  const depth = stepsBelow(start, path)
  // two entries popped by one fast swipe both answer before the page has drawn:
  // the lower target wins, as the history really stands there
  const target = useRef(depth)
  useEffect(() => {
    target.current = depth
  }, [depth])
  const up = (to: number) => {
    if (to >= target.current) return
    target.current = to
    onNavigate(pathAtDepth(start, path, to))
  }
  return Array.from({ length: depth }, (_, k) => <Step key={k} onBack={() => up(k)} />)
}
