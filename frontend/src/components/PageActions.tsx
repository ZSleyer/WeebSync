import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMediaQuery } from '@weebsync/design-system'

/** The app bar's actions slot: the element the shell holds in state. */
export const AppBarActions = createContext<HTMLElement | null>(null)
/** The shell's footer row above the tab bar, for a page's action bar. */
export const ShellFooter = createContext<HTMLElement | null>(null)

export const WIDE_MQ = '(width >= 64rem)'

/**
 * A page's secondary controls: rendered inline where the page draws its own
 * header (desktop), and into the app bar's actions slot on a phone, where the
 * in-page header is hidden. Width-based and read synchronously, so exactly
 * one copy ever mounts - a menu's document listeners must not register twice.
 */
export default function PageActions({ children }: { children: ReactNode }) {
  const node = useContext(AppBarActions)
  const wide = useMediaQuery(WIDE_MQ)
  if (wide) return <>{children}</>
  return node ? createPortal(children, node) : null
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
