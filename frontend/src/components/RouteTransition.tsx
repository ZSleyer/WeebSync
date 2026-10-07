import { createContext, useContext, useState, type ReactNode } from 'react'
import { Outlet, useLocation } from 'react-router'

// How a navigation moves the screen, after the platform conventions:
// - another top-level page (tab bar, sidebar): it fades in where the old one
//   stood, no sideways travel - the tabs have no order a slide could mean;
// - deeper into a page (hub to a section, a screen with a back link): the
//   new screen comes in from the right, and going back up from the left;
// - a sibling inside a page (a suggestions tab, a desktop settings section):
//   only the content fades, the heading, menu and tabs stand still.
const PAGE = 'anim-t-reveal'
const PUSH = 'anim-slide-from-right'
const POP = 'anim-slide-from-left'
const SWAP = 'anim-fade-in'

interface Screen {
  path: string
  /** the screen's back link, if it is stacked on another */
  back?: string
}

/** The top-level page a path belongs to: what keys <main>. */
export const topPage = (path: string) => '/' + (path.split('/')[1] ?? '')

const depth = (path: string) => path.split('/').filter(Boolean).length

/**
 * The classes for a navigation from `from` to `to`: `page` for <main>, which
 * remounts only when the top-level page changes, `section` for a page's own
 * outlet, which remounts on every path inside it. On a desktop the sections
 * of a page sit side by side with their menu, so moving between them is
 * never deeper or shallower, only a swap.
 */
export function routeMotion(
  from: Screen,
  to: Screen,
  wide: boolean,
  replace = false,
): { page: string; section: string } {
  // the same screen, or an index forwarding to its first section: the page
  // already moved when the index came in
  if (from.path === to.path || (replace && to.path.startsWith(from.path + '/'))) return { page: '', section: '' }
  const samePage = topPage(from.path) === topPage(to.path)
  let step: string
  if (!samePage) {
    // another page, unless one is stacked on the other (Rename on Files):
    // a tab tapped from deep inside a page is still a change of page
    step =
      to.back && topPage(to.back) === topPage(from.path)
        ? PUSH
        : from.back && topPage(from.back) === topPage(to.path)
          ? POP
          : PAGE
  } else if (wide) {
    step = SWAP
  } else {
    const deeper = (to.back && !from.back) || (!!to.back === !!from.back && depth(to.path) > depth(from.path))
    const shallower = (from.back && !to.back) || (!!to.back === !!from.back && depth(to.path) < depth(from.path))
    step = deeper ? PUSH : shallower ? POP : SWAP
  }
  return samePage ? { page: '', section: step } : { page: step, section: '' }
}

/** The class a page's outlet animates with on this navigation. */
export const SectionMotion = createContext('')

// RouteTransition drops the animation class once it finished: a filled
// transform animation keeps the wrapper a containing block, which would pin
// position:fixed descendants (e.g. the browser's selection bar) to the page
// instead of the viewport. Remounted by its key, it plays from scratch.
export function RouteTransition({ cls, children }: { cls: string; children: ReactNode }) {
  const [done, setDone] = useState(false)
  return (
    // the layout classes have to survive the animation class being dropped:
    // they are what lets a page claim the remaining height of <main>
    <div
      className={`flex min-h-0 flex-1 flex-col${cls && !done ? ' ' + cls : ''}`}
      onAnimationEnd={(e) => e.target === e.currentTarget && setDone(true)}
    >
      {children}
    </div>
  )
}

/** A page's <Outlet>, animated per section change. */
export function SectionOutlet() {
  const cls = useContext(SectionMotion)
  const { pathname } = useLocation()
  return (
    <RouteTransition key={pathname} cls={cls}>
      <Outlet />
    </RouteTransition>
  )
}
