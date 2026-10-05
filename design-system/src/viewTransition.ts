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
export function localTransition(scope: HTMLElement | null, update: () => void): Promise<void> {
  const root = document.documentElement
  const still =
    root.dataset.motion === 'off' ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  if (!document.startViewTransition || still) {
    update()
    return Promise.resolve()
  }
  root.setAttribute('data-vt-local', '')
  scope?.setAttribute('data-vt', '')
  const done = () => {
    root.removeAttribute('data-vt-local')
    scope?.removeAttribute('data-vt')
  }
  return document.startViewTransition(update).finished.then(done, done)
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
  root.setAttribute('data-vt-local', '')
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
  const done = () => root.removeAttribute('data-vt-local')
  return t.finished.then(done, done)
}

/**
 * One element becomes another: the element clicked (a poster in a list) flies
 * to where its counterpart stands once `update` has run (the poster in the
 * dialog it opened), while the rest of the change happens around it. The
 * counterpart carries `data-morph-target`; the stylesheet names it only while
 * the root carries `data-vt-morph`, so two names never meet.
 */
export function morphTransition(from: HTMLElement, update: () => void): Promise<void> {
  const root = document.documentElement
  const still =
    root.dataset.motion === 'off' ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  if (!document.startViewTransition || still) {
    update()
    return Promise.resolve()
  }
  root.setAttribute('data-vt-local', '')
  root.setAttribute('data-vt-morph', '')
  from.style.viewTransitionName = 'morph'
  const t = document.startViewTransition(() => {
    from.style.viewTransitionName = ''
    update()
  })
  const done = () => {
    root.removeAttribute('data-vt-local')
    root.removeAttribute('data-vt-morph')
    from.style.viewTransitionName = ''
  }
  return t.finished.then(done, done)
}
