import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { useTranslation } from 'react-i18next'

const MAIN = '.app-shell > main'

/** Puts focus on the page's heading, else on <main>, without scrolling or a ring. */
export function focusMain(): boolean {
  const main = document.querySelector<HTMLElement>(MAIN)
  if (!main) return false
  const active = document.activeElement as HTMLElement | null
  // a page that put the caret somewhere on purpose (an autofocused field), or a
  // dialog that is still up, keeps its focus
  if (active && active !== document.body) {
    if (main.contains(active) && active.matches('input, textarea, select, [contenteditable], [autofocus]')) return false
    if (active.closest('dialog[open], [role="dialog"], [role="alertdialog"]')) return false
  }
  const target = main.querySelector<HTMLElement>('h1') ?? main
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
  return true
}

const keepsFocus = () => {
  const el = document.activeElement
  return !!el && el !== document.body && el.isConnected
}

/**
 * Route changes for keyboard and screen reader users (WCAG 2.4.1, 4.1.3): the
 * first focusable element is a link past the navigation; after a push or a
 * replace that changes the page, focus moves to its heading and the new title
 * is announced politely. A back or forward step keeps focus where it is: the
 * browser restores the scroll position, and focus should not jump away from it.
 */
export default function RouteFocus({ title }: { title: string }) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const navType = useNavigationType()
  const last = useRef(pathname)
  const [said, setSaid] = useState('')
  useEffect(() => {
    if (last.current === pathname) return
    last.current = pathname
    setSaid(title)
    // a step back or forward keeps focus where it is - unless that element
    // went with the old page, which leaves the focus on <body>
    if (navType === 'POP' && keepsFocus()) return
    // once the new page has painted: its own autofocus has run by then
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => focusMain())
    })
    return () => cancelAnimationFrame(frame)
    // the title belongs to the same commit as the path
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])
  return (
    <>
      <a
        href="#main"
        className="ws-skip"
        onClick={(e) => {
          e.preventDefault()
          const main = document.querySelector<HTMLElement>(MAIN)
          if (!main) return
          main.setAttribute('tabindex', '-1')
          main.focus()
        }}
      >
        {t('app.skipToContent')}
      </a>
      <div role="status" aria-live="polite" className="sr-only">
        {said}
      </div>
    </>
  )
}
