import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { useCloseWatcher } from './useCloseWatcher'

/**
 * Open/close state for a dropdown, with the two behaviours every menu needs and
 * everyone forgets: a click outside closes it, and so does Escape. Returns a ref
 * for the wrapper that counts as "inside" - put it on the element containing
 * both the trigger and the list - and an anchor name for the wrapper, so the
 * list can open in the top layer, attached to it, clear of any overflow clip
 * between the wrapper and the viewport.
 *
 *   const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
 *   <div ref={ref} className="relative" style={anchorStyle}>
 *     <Button onClick={() => setOpen(!open)} aria-expanded={open}>Sortieren</Button>
 *     {open && <Menu aria-label="Sortieren nach" anchor={anchor} placement="bottom-end">…</Menu>}
 *   </div>
 */
export function useMenu<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false)
  const ref = useRef<T>(null)
  // one name per menu: a popover sits in the top layer, which counts as "after
  // everything" in tree order, so with a shared name every menu would attach
  // to the last wrapper on the page. useId's delimiters are not <dashed-ident>
  // characters (":r1:" in React 18, "«r1»" in 19).
  const anchor = `--menu-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const anchorStyle: CSSProperties = { anchorName: anchor }

  // the back gesture closes the open menu instead of leaving the page
  useCloseWatcher(() => setOpen(false), open)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') {
          setOpen(false)
          // focus goes back to the trigger (the control carrying
          // aria-expanded), so a keyboard user is not dropped onto the body
          if (ref.current?.contains(document.activeElement))
            ref.current.querySelector<HTMLElement>('[aria-expanded]')?.focus()
        }
      } else if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    // choosing an item that closes the menu: hand the focus to the trigger
    // before the item's own handler runs (capture), so a dialog the action
    // opens takes the trigger as its opener and returns to it. An item that
    // keeps the menu open (data-keep-open, or aria-disabled) keeps the focus,
    // so the arrow keys carry on from it.
    const onPick = (e: Event) => {
      const item = e.target instanceof Element ? e.target.closest<HTMLElement>('[role^="menuitem"], [role="option"]') : null
      if (!item || !ref.current?.contains(item)) return
      if (item.hasAttribute('data-keep-open') || item.getAttribute('aria-disabled') === 'true') return
      ref.current.querySelector<HTMLElement>('[aria-expanded]')?.focus()
    }
    document.addEventListener('click', onPick, true)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onDoc)
    // a scroll outside the list moves the anchor, possibly out of its clipping
    // container while the list stays put in the top layer - close instead
    document.addEventListener('scroll', onDoc, true)
    return () => {
      document.removeEventListener('click', onPick, true)
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onDoc)
      document.removeEventListener('scroll', onDoc, true)
    }
  }, [open])

  return { open, setOpen, ref, anchor, anchorStyle }
}
