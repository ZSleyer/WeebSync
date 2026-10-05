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
