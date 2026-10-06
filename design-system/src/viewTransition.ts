import { SHEET_MQ } from './useMediaQuery'

// A view transition for one part of the page - a list that reorders, a colour
// that changes - rather than for a route.
//
// The shell names <main> for the route transition, and that name is live for
// every view transition on the page: a local one would also fade the whole page
// out and slide it back in. While a local transition runs, the root carries
// `data-vt-local` and the stylesheet takes the name off <main>. The scope gets
// `data-vt`, which hands each child its own name from `--vt`, so the children
// move as themselves and only while the transition lasts - permanent names
// would cut them out of every other transition, the route's included.
//
// `update` must change the DOM synchronously: a React state update goes through
// flushSync, or the transition captures the new state before it exists.
// Overlapping local transitions share the root's flag: counted, so the first
// to finish does not hand <main> its route name back under the second.
let locals = 0
const holdLocal = () => {
  locals++
  document.documentElement.setAttribute('data-vt-local', '')
}
const dropLocal = () => {
  if (--locals <= 0) {
    locals = 0
    document.documentElement.removeAttribute('data-vt-local')
  }
}

export function localTransition(scope: HTMLElement | null, update: () => void): Promise<void> {
  const root = document.documentElement
  const still =
    root.dataset.motion === 'off' ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  if (!document.startViewTransition || still) {
    update()
    return Promise.resolve()
  }
  holdLocal()
  scope?.setAttribute('data-vt', '')
  const done = () => {
    dropLocal()
    scope?.removeAttribute('data-vt')
  }
  const t = document.startViewTransition(update)
  // a transition skipped by the next one rejects `ready`; nothing to report
  t.ready.catch(() => {})
  return t.finished.then(done, done)
}

// how long the accent wave takes to cover the screen: over the usual 300ms on
// purpose - it happens once per choice, and it is the choice's confirmation
const REVEAL_MS = 420

/**
 * The page repaints from a point outwards: the new state grows as a circle
 * from (x, y) until it covers the screen. For a change of the whole look - a
 * new accent - picked at that point. <main> loses its route name meanwhile,
 * as in localTransition, or it would cross-fade on its own above the wave.
 */
export function revealTransition(x: number, y: number, update: () => void): Promise<void> {
  const root = document.documentElement
  const still =
    root.dataset.motion === 'off' ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  if (!document.startViewTransition || still) {
    update()
    return Promise.resolve()
  }
  holdLocal()
  const t = document.startViewTransition(update)
  const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  t.ready
    .then(() =>
      root.animate(
        { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
        { duration: REVEAL_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)', pseudoElement: '::view-transition-new(root)' },
      ),
    )
    .catch(() => {})
  return t.finished.then(dropLocal, dropLocal)
}

/**
 * A poster opens into its dialog (a container transform): the dialog grows
 * out of the poster's own box, the picture fading into the dialog on the way,
 * so the dialog reads as the poster opened up rather than a layer laid over
 * the page. `back` runs it the other way as the dialog closes: it shrinks into
 * the poster it came from. The stylesheet names the open dialog while the root
 * carries `data-vt-morph`; this names the poster. A bottom sheet on a phone is
 * not paired - it rises from the edge, and a poster growing into a sheet would
 * fly against the way it moves.
 */
export function morphTransition(from: HTMLElement, update: () => void, back = false): Promise<void> {
  const root = document.documentElement
  const still =
    root.dataset.motion === 'off' ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  if (!document.startViewTransition || still || !from.isConnected) {
    update()
    return Promise.resolve()
  }
  const pair = typeof matchMedia !== 'function' || !matchMedia(SHEET_MQ).matches
  holdLocal()
  root.setAttribute('data-vt-morph', '')
  if (back) root.setAttribute('data-vt-back', '')
  const name = (on: boolean) => {
    if (pair) from.style.viewTransitionName = on ? 'morph-dialog' : ''
  }
  // the poster is the dialog's other half on the side where the dialog is not
  name(!back)
  const t = document.startViewTransition(() => {
    name(back)
    update()
  })
  t.ready.catch(() => {})
  const done = () => {
    dropLocal()
    root.removeAttribute('data-vt-morph')
    root.removeAttribute('data-vt-back')
    from.style.viewTransitionName = ''
  }
  return t.finished.then(done, done)
}
