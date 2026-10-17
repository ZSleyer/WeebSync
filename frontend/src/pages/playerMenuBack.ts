import { useEffect, useRef, useState } from 'react'
import { useCloseWatcher } from 'fluid-lycoris'

const MENU = 'media-chrome-menu, media-settings-menu'

/**
 * The player's own menus (settings, subtitles, audio, their submenus) are
 * media-chrome elements that open and close by their `hidden` attribute and
 * say so with a bubbling toggle event. While one is open the back gesture
 * closes the latest one opened - a submenu before the menu it came from -
 * instead of leaving the player.
 */
export function usePlayerMenuBack() {
  const stack = useRef<HTMLElement[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = (e: Event) => {
      const el = e.target as HTMLElement
      if (!el.matches?.(MENU)) return
      stack.current = stack.current.filter((x) => x !== el)
      if ((e as Event & { newState?: string }).newState === 'open') stack.current.push(el)
      setOpen(stack.current.length > 0)
    }
    document.addEventListener('toggle', on, true)
    return () => document.removeEventListener('toggle', on, true)
  }, [])
  useCloseWatcher(() => {
    const top = stack.current.at(-1)
    if (top) top.hidden = true
  }, open)
}
