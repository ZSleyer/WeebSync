import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { EASE_THROW } from '@weebsync/design-system'

// Drag a row by its handle to a new place in a list. Pointer events, so a mouse
// and a finger drag alike; the handle carries `touch-action: none`, the rest of
// the row still scrolls the page. The rows in between make room while the
// dragged one passes them, and on release it glides into the gap before the
// order is committed - so the commit changes nothing on screen.
//
// The keyboard moves the same way: arrows one place, Home and End to the ends.
//
// Rows are found in `list` by `data-reorder-id`; `ids` is the reorderable set in
// its current order. Rows of the list that are not in `ids` stay put.
// ponytail: no auto-scroll at the viewport edge; a long queue drags in steps.

const SHIFT_MS = 200

export function useDragReorder({
  list,
  ids,
  onMove,
}: {
  list: RefObject<HTMLElement | null>
  ids: number[]
  /** `dragged`: the rows already stand in their new places, no animation needed */
  onMove: (id: number, to: number, dragged: boolean) => void
}) {
  const drag = useRef<{
    id: number
    pointer: number
    y: number
    from: number
    to: number
    rows: HTMLElement[]
    rects: DOMRect[]
    room: number
  } | null>(null)

  const rowOf = (id: number) => list.current?.querySelector<HTMLElement>(`[data-reorder-id="${id}"]`) ?? null
  const refocus = (id: number) =>
    requestAnimationFrame(() => rowOf(id)?.querySelector<HTMLElement>('[data-reorder-handle]')?.focus())

  const clear = (rows: HTMLElement[]) =>
    rows.forEach((r) => {
      r.style.transition = ''
      r.style.transform = ''
      r.style.position = ''
      r.style.zIndex = ''
    })

  return (id: number) => ({
    'data-reorder-handle': '',
    style: { touchAction: 'none', cursor: 'grab' } as const,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || drag.current) return
      const rows = ids.map(rowOf).filter((r): r is HTMLElement => !!r)
      const from = ids.indexOf(id)
      if (from < 0 || rows.length !== ids.length) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      const rects = rows.map((r) => r.getBoundingClientRect())
      // what a row needs to make room: the dragged row's height plus the gap
      const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0
      rows[from].style.position = 'relative'
      rows[from].style.zIndex = '2'
      rows[from].style.transition = 'none'
      drag.current = {
        id,
        pointer: e.pointerId,
        y: e.clientY,
        from,
        to: from,
        rows,
        rects,
        room: rects[from].height + gap,
      }
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current
      if (!d || e.pointerId !== d.pointer) return
      const dy = e.clientY - d.y
      d.rows[d.from].style.transform = `translateY(${dy}px)`
      const mid = d.rects[d.from].top + d.rects[d.from].height / 2 + dy
      let to = d.from
      d.rows.forEach((r, j) => {
        if (j === d.from) return
        const c = d.rects[j].top + d.rects[j].height / 2
        const shift = j > d.from && mid > c ? -d.room : j < d.from && mid < c ? d.room : 0
        if (shift < 0) to++
        if (shift > 0) to--
        r.style.transition = `transform ${SHIFT_MS}ms var(--ease-out)`
        r.style.transform = shift ? `translateY(${shift}px)` : ''
      })
      d.to = to
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current
      if (!d || e.pointerId !== d.pointer) return
      drag.current = null
      if (d.to === d.from) {
        const row = d.rows[d.from]
        row.style.transition = `transform ${SHIFT_MS}ms ${EASE_THROW}`
        row.style.transform = ''
        setTimeout(() => clear(d.rows), SHIFT_MS)
        return
      }
      // glide into the gap: down, the dragged row ends where the last row it
      // passed ended; up, where the first one it passed began
      const top = d.to > d.from ? d.rects[d.to].bottom - d.rects[d.from].height : d.rects[d.to].top
      const row = d.rows[d.from]
      row.style.transition = `transform ${SHIFT_MS}ms ${EASE_THROW}`
      row.style.transform = `translateY(${top - d.rects[d.from].top}px)`
      setTimeout(() => {
        clear(d.rows)
        onMove(d.id, d.to, true)
        refocus(d.id)
      }, SHIFT_MS)
    },
    onPointerCancel: () => {
      const d = drag.current
      drag.current = null
      if (d) clear(d.rows)
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const i = ids.indexOf(id)
      const to = { ArrowUp: i - 1, ArrowDown: i + 1, Home: 0, End: ids.length - 1 }[e.key]
      if (to === undefined) return
      e.preventDefault()
      if (to < 0 || to >= ids.length || to === i) return
      onMove(id, to, false)
      refocus(id)
    },
  })
}
