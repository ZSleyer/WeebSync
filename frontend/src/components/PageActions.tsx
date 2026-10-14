import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMediaQuery } from 'fluid-lycoris'

/** The app bar's actions slot: the element the shell holds in state. */
export const AppBarActions = createContext<HTMLElement | null>(null)
/**
 * The actions slot of the desktop title row. `undefined` where the screen
 * has no title row (a stacked screen): the actions then stay where the page
 * renders them. `null` while the row is mounting.
 */
export const TitleActions = createContext<HTMLElement | null | undefined>(undefined)
/** The shell's footer row above the tab bar, for a page's action bar. */
export const ShellFooter = createContext<HTMLElement | null>(null)
/** The phone's toolbar slot, which stands in for the tab bar while it holds something. */
export const ShellToolbar = createContext<HTMLElement | null>(null)

export const WIDE_MQ = '(width >= 64rem)'

/**
 * A page's secondary controls: in the desktop title row beside the page's
 * h1 (inline where the screen has no title row), and in the app bar's
 * actions slot on a phone. Width-based and read synchronously, so exactly
 * one copy ever mounts - a menu's document listeners must not register twice.
 */
export default function PageActions({ children }: { children: ReactNode }) {
  const bar = useContext(AppBarActions)
  const title = useContext(TitleActions)
  const wide = useMediaQuery(WIDE_MQ)
  if (wide) {
    if (title === undefined) return <>{children}</>
    return title ? createPortal(children, title) : null
  }
  return bar ? createPortal(children, bar) : null
}

/**
 * A page's primary action bar: in flow where the page renders it (desktop),
 * and into the shell's footer row above the tab bar on a phone, so it sits on
 * the tab bar no matter how short or long the page is.
 */
export function PageFooter({ children }: { children: ReactNode }) {
  const node = useContext(ShellFooter)
  const wide = useMediaQuery(WIDE_MQ)
  if (wide) return <>{children}</>
  return node ? createPortal(children, node) : null
}

/**
 * A page's toolbar that takes the tab bar's place on a phone while it is up
 * (a selection's actions), as native apps swap their bottom bar. On a desktop
 * it renders where the page puts it (the page floats it itself).
 */
export function PageToolbar({ children }: { children: ReactNode }) {
  const node = useContext(ShellToolbar)
  const wide = useMediaQuery(WIDE_MQ)
  if (wide) return <>{children}</>
  return node ? createPortal(children, node) : null
}
