import { useEffect, useRef, useState } from 'react'

/**
 * Open/close state for a dropdown, with the two behaviours every menu needs and
 * everyone forgets: a click outside closes it, and so does Escape. Returns a ref
 * for the wrapper that counts as "inside" - put it on the element containing
 * both the trigger and the list.
 *
 *   const { open, setOpen, ref } = useMenu()
 *   <div ref={ref} className="relative">
 *     <Button onClick={() => setOpen(!open)} aria-expanded={open}>Sortieren</Button>
 *     {open && <Menu aria-label="Sortieren nach" className="absolute right-0 z-20 mt-1">…</Menu>}
 *   </div>
 */
export function useMenu<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false)
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') setOpen(false)
      } else if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onDoc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onDoc)
    }
  }, [open])

  return { open, setOpen, ref }
}
