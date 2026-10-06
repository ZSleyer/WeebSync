import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react'
import { haptic } from './haptics'

// how long a finger rests before the press counts as long; the platform
// menus sit around here (Android's long-press timeout is 400-500ms)
const HOLD_MS = 450
// a finger that travels this far is scrolling, not holding
const MOVE_SLOP = 8

export interface LongPressHandlers {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onContextMenu: (e: MouseEvent<HTMLElement>) => void
  onClickCapture: (e: MouseEvent<HTMLElement>) => void
  'data-longpress': ''
}

/**
 * A long press with a finger, as the shortcut to an element's menu. The
 * element sinks a little while the finger rests (`data-pressing`, styled in
 * the app's sheet), then the menu opens with a tick and the click that would
 * follow the release is swallowed - the press opened the menu, not the item.
 *
 * Touch only. A mouse keeps the browser's own context menu - open in a new
 * tab, copy the image - and reaches the same menu through the visible button,
 * which every element using this has to keep (WCAG 2.5.7).
 */
// a part of the row with a press of its own - the reorder grip, where a finger
// rests before it drags - never opens the sheet
const NO_PRESS = '[data-reorder-handle], [data-no-longpress]'

export function useLongPress(onLongPress: (() => void) | undefined): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const start = useRef<{ x: number; y: number; el: HTMLElement } | null>(null)
  const fired = useRef(false)
  const touch = useRef(false)
  const live = useRef(onLongPress)
  live.current = onLongPress
  useEffect(() => () => clearTimeout(timer.current), [])

  const stop = () => {
    clearTimeout(timer.current)
    start.current?.el.removeAttribute('data-pressing')
    start.current = null
  }

  return {
    'data-longpress': '',
    onPointerDown: (e) => {
      touch.current = e.pointerType === 'touch'
      fired.current = false
      if (!touch.current || !live.current) return
      if ((e.target as HTMLElement | null)?.closest?.(NO_PRESS)) return
      const el = e.currentTarget
      start.current = { x: e.clientX, y: e.clientY, el }
      el.setAttribute('data-pressing', '')
      timer.current = setTimeout(() => {
        stop()
        fired.current = true
        haptic(8)
        live.current?.()
      }, HOLD_MS)
    },
    onPointerMove: (e) => {
      const s = start.current
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_SLOP) stop()
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    // Android raises its own context menu for the same press; a mouse keeps it
    onContextMenu: (e) => {
      if (touch.current && live.current) e.preventDefault()
    },
    onClickCapture: (e) => {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  }
}
