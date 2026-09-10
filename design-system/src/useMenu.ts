import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'

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

  useEffect(() => {
    if (!open) return
    const onDoc = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') setOpen(false)
      } else if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onDoc)
    // a scroll outside the list moves the anchor, possibly out of its clipping
    // container while the list stays put in the top layer - close instead
    document.addEventListener('scroll', onDoc, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onDoc)
      document.removeEventListener('scroll', onDoc, true)
    }
  }, [open])

  return { open, setOpen, ref, anchor, anchorStyle }
}
