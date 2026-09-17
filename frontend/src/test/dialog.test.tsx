import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from '@weebsync/design-system'

// HTMLDialogElement is shimmed in src/test/setup.ts because jsdom 29 ships no
// dialog behaviour. What the shim covers is exactly what these tests assert on:
// showModal flips `open`, close clears it and fires the close event. Escape and
// the real backdrop are not simulated by jsdom either, so the two paths that
// reach the guard - the cancel event and a backdrop pointerdown plus click -
// are dispatched directly here.

const dialogOf = (container: HTMLElement) => container.querySelector('dialog') as HTMLDialogElement

/** Escape on a native dialog surfaces as a cancelable `cancel` event. */
const pressEscape = (el: HTMLDialogElement) => fireEvent(el, new Event('cancel', { cancelable: true }))

/** A real backdrop click is a pointerdown and a click, both hitting the dialog itself. */
const clickBackdrop = (el: HTMLDialogElement) => {
  fireEvent.pointerDown(el)
  fireEvent.click(el)
}

describe('Dialog', () => {
  it('opens itself as a modal on mount', () => {
    const { container } = render(<Dialog onClose={() => {}}>Inhalt</Dialog>)
    expect(dialogOf(container).open).toBe(true)
    expect(screen.getByText('Inhalt')).toBeInTheDocument()
  })

  it('applies the width, the aria label and the body classes', () => {
    const { container } = render(
      <Dialog onClose={() => {}} width="max-w-2xl" aria-label="Watch bearbeiten" bodyClassName="dialog-body" danger>
        Inhalt
      </Dialog>,
    )
    const dialog = dialogOf(container)
    expect(dialog).toHaveClass('w-full', 'p-0', 'max-w-2xl')
    expect(dialog).toHaveAttribute('aria-label', 'Watch bearbeiten')
    // overflow-y-auto is the scroll container of last resort: without it a
    // dialog whose content outgrows the screen is simply cut off, since the
    // dialog element itself is overflow:hidden by design
    expect(dialog.firstElementChild).toHaveClass(
      'flex',
      'flex-col',
      'overflow-y-auto',
      't-panel--danger',
      'dialog-body',
    )
  })

  it('reports the close exactly once through the dialog close event', async () => {
    const onClose = vi.fn()
    const { container } = render(<Dialog onClose={onClose}>Inhalt</Dialog>)
    clickBackdrop(dialogOf(container))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(dialogOf(container).open).toBe(false)
  })

  it('closes on a backdrop click only when the press started on the backdrop', async () => {
    const onClose = vi.fn()
    const { container } = render(
      <Dialog onClose={onClose}>
        <button type="button">Feld</button>
      </Dialog>,
    )
    const dialog = dialogOf(container)
    // a drag that began inside a control and merely ended on the backdrop
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Feld' }))
    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)
  })

  it('ignores a click that lands inside the body', () => {
    const onClose = vi.fn()
    const { container } = render(
      <Dialog onClose={onClose}>
        <button type="button">Feld</button>
      </Dialog>,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Feld' }))
    fireEvent.click(screen.getByRole('button', { name: 'Feld' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(dialogOf(container).open).toBe(true)
  })

  it('keeps the dialog open when onRequestClose declines - the unsaved guard', async () => {
    const onClose = vi.fn()
    const onRequestClose = vi.fn(() => false)
    const { container } = render(
      <Dialog onClose={onClose} onRequestClose={onRequestClose}>
        Inhalt
      </Dialog>,
    )
    const dialog = dialogOf(container)
    clickBackdrop(dialog)
    await waitFor(() => expect(onRequestClose).toHaveBeenCalledTimes(1))
    expect(onClose).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)
  })

  it('closes when onRequestClose agrees', async () => {
    const onClose = vi.fn()
    const { container } = render(
      <Dialog onClose={onClose} onRequestClose={() => true}>
        Inhalt
      </Dialog>,
    )
    clickBackdrop(dialogOf(container))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('awaits a promise from onRequestClose before closing', async () => {
    const onClose = vi.fn()
    let settle = (_: boolean) => {}
    const { container } = render(
      <Dialog onClose={onClose} onRequestClose={() => new Promise<boolean>((r) => (settle = r))}>
        Inhalt
      </Dialog>,
    )
    const dialog = dialogOf(container)
    clickBackdrop(dialog)
    expect(dialog.open).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    settle(true)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(dialog.open).toBe(false)
  })

  it('routes Escape through the same guard', async () => {
    const onClose = vi.fn()
    const onRequestClose = vi.fn(() => false)
    const { container } = render(
      <Dialog onClose={onClose} onRequestClose={onRequestClose}>
        Inhalt
      </Dialog>,
    )
    const dialog = dialogOf(container)
    pressEscape(dialog)
    await waitFor(() => expect(onRequestClose).toHaveBeenCalledTimes(1))
    expect(onClose).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)
  })

  it('leaves Escape to an open menu inside the dialog', () => {
    const onClose = vi.fn()
    const { getByRole } = render(
      <Dialog onClose={onClose}>
        <button aria-haspopup="listbox" aria-expanded="true">
          Mehr
        </button>
      </Dialog>,
    )
    fireEvent.keyDown(getByRole('button'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves Escape to an open menu even when the key lands on the dialog itself', () => {
    // on touch the trigger never takes focus, so the keydown target is the
    // dialog, not a descendant of the expanded button
    const onClose = vi.fn()
    const { container } = render(
      <Dialog onClose={onClose}>
        <button aria-haspopup="listbox" aria-expanded="true">
          Mehr
        </button>
      </Dialog>,
    )
    // cancelled, or Chrome's close watcher closes the dialog from the key's
    // default action anyway; the platform's cancel is held off the same way
    expect(fireEvent.keyDown(dialogOf(container), { key: 'Escape' })).toBe(false)
    expect(fireEvent(dialogOf(container), new Event('cancel', { cancelable: true }))).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(dialogOf(container).open).toBe(true)
  })

  it('does not let an expanded disclosure swallow Escape', () => {
    const onClose = vi.fn()
    const { container } = render(
      <Dialog onClose={onClose}>
        <button aria-expanded="true">Durchsuchen</button>
      </Dialog>,
    )
    fireEvent.keyDown(dialogOf(container), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // ── the back gesture ──
  // jsdom keeps a real history: pushState and popstate work, back() does not
  // traverse, so the pop is simulated by replacing the state and firing the
  // event - which is what the browser does before it dispatches popstate.
  const popBack = () => {
    const { wsDialog: _gone, ...rest } = history.state ?? {}
    history.replaceState(rest, '')
    fireEvent.popState(window)
  }

  it('holds one history entry while open and closes when it is popped', async () => {
    const onClose = vi.fn()
    const before = history.state?.idx ?? 0
    const { container } = render(<Dialog onClose={onClose}>Inhalt</Dialog>)
    expect(history.state.wsDialog).toBeTruthy()
    expect(history.state.idx).toBe(before + 1)
    popBack()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(dialogOf(container).open).toBe(false)
  })

  it('puts the entry back when the guard declines the back gesture', async () => {
    const onClose = vi.fn()
    const onRequestClose = vi.fn(() => false)
    const { container } = render(
      <Dialog onClose={onClose} onRequestClose={onRequestClose}>
        Inhalt
      </Dialog>,
    )
    const mark = history.state.wsDialog
    popBack()
    await waitFor(() => expect(onRequestClose).toHaveBeenCalledTimes(1))
    expect(onClose).not.toHaveBeenCalled()
    expect(dialogOf(container).open).toBe(true)
    expect(history.state.wsDialog).toBe(mark)
  })

  it('only the inner of two nested dialogs answers a pop', async () => {
    const outer = vi.fn()
    const inner = vi.fn()
    const { rerender } = render(<Dialog onClose={outer}>Außen</Dialog>)
    const outerMark = history.state
    rerender(
      <Dialog onClose={outer}>
        <Dialog onClose={inner}>Innen</Dialog>
      </Dialog>,
    )
    expect(history.state.wsDialog).not.toBe(outerMark.wsDialog)
    // back lands on the outer dialog's entry
    history.replaceState(outerMark, '')
    fireEvent.popState(window)
    await waitFor(() => expect(inner).toHaveBeenCalledTimes(1))
    expect(outer).not.toHaveBeenCalled()
  })

  it('takes its entry with it when the owner unmounts it', async () => {
    const back = vi.spyOn(history, 'back').mockImplementation(() => {})
    const { unmount } = render(<Dialog onClose={() => {}}>Inhalt</Dialog>)
    unmount()
    // deferred, so a StrictMode remount can still cancel it
    expect(back).not.toHaveBeenCalled()
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1))
    back.mockRestore()
  })

  it('survives a StrictMode double mount with one entry and no back', async () => {
    // development React mounts, unmounts and mounts the effect again; the
    // dialog closed itself on the spot when the cleanup's back() popped the
    // page's entry after the second mount had pushed a fresh one
    const back = vi.spyOn(history, 'back').mockImplementation(() => {})
    const onClose = vi.fn()
    const before = history.state?.idx ?? 0
    const { container } = render(
      <StrictMode>
        <Dialog onClose={onClose}>Inhalt</Dialog>
      </StrictMode>,
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(back).not.toHaveBeenCalled()
    expect(history.state.idx).toBe(before + 1)
    expect(dialogOf(container).open).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    back.mockRestore()
  })

  // ── bottom sheet on phones ──
  // jsdom's matchMedia always reports `matches: false`, so the narrow case is
  // stubbed. Restored per test, since the component reads it on first render.
  const withNarrowViewport = (matches: boolean) => {
    const real = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    return () => {
      window.matchMedia = real
    }
  }

  // The pull-down: pointer events from anywhere on the sheet, distances in
  // clientY. `ms` is how long the gesture takes, because the release reads the
  // speed as well as the distance - a short flick dismisses, a short slow pull
  // settles back, and firing the events instantly would make every pull a
  // flick of infinite speed.
  const pull = async (from: HTMLElement, dialog: HTMLDialogElement, dy: number, ms = 300) => {
    fireEvent.pointerDown(from, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(dialog, { clientY: 100 + dy / 2, pointerId: 1 })
    fireEvent.pointerMove(dialog, { clientY: 100 + dy, pointerId: 1 })
    await new Promise((r) => setTimeout(r, ms))
    fireEvent.pointerUp(dialog, { clientY: 100 + dy, pointerId: 1 })
  }

  const sheet = (props: Partial<Parameters<typeof Dialog>[0]> = {}) =>
    render(
      <Dialog onClose={() => {}} width="max-w-2xl" {...props}>
        <div className="dialog-body">
          <header>Kopf</header>
          <section className="overflow-y-auto">Inhalt</section>
        </div>
      </Dialog>,
    )

  /** Make an element look like a scroller parked at `top` to the gesture.
   *  The overflow has to be inline: jsdom computes no styles from the sheet,
   *  so the class alone leaves it `visible` and the element is no scroller. */
  const asScroller = (el: HTMLElement, top: number) => {
    el.style.overflowY = 'auto'
    Object.defineProperty(el, 'scrollHeight', { value: 900, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(el, 'scrollTop', { value: top, configurable: true })
  }

  it('closes a sheet pulled down by its header', async () => {
    const restore = withNarrowViewport(true)
    const onClose = vi.fn()
    const { container } = sheet({ onClose })
    const dialog = dialogOf(container)
    await pull(screen.getByText('Kopf'), dialog, 200)
    // the sheet slides out first; the close waits for the transition
    await waitFor(() => expect(dialog.style.transform).toBe('translateY(100%)'))
    fireEvent.transitionEnd(dialog)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    restore()
  })

  // The whole point of the rewrite: a sheet follows the finger from its whole
  // face. Restricting the pull to the header is what people notice as wrong.
  it('closes a sheet pulled down by its body, not just its header', async () => {
    const restore = withNarrowViewport(true)
    const onClose = vi.fn()
    const { container } = sheet({ onClose })
    const dialog = dialogOf(container)
    await pull(screen.getByText('Inhalt'), dialog, 200)
    await waitFor(() => expect(dialog.style.transform).toBe('translateY(100%)'))
    fireEvent.transitionEnd(dialog)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    restore()
  })

  // ...but only while the content under the finger is at its top. Below that
  // the move is the scroller's, or the sheet would dismiss itself whenever
  // someone scrolled back up.
  it('leaves the move to a scrolled content area', async () => {
    const restore = withNarrowViewport(true)
    const onClose = vi.fn()
    const { container } = sheet({ onClose })
    const dialog = dialogOf(container)
    const body = screen.getByText('Inhalt')
    asScroller(body, 240)
    await pull(body, dialog, 300)
    expect(dialog.style.transform).toBe('')
    expect(onClose).not.toHaveBeenCalled()
    // scrolled back to the top, the same pull is the sheet's
    asScroller(body, 0)
    await pull(body, dialog, 300)
    expect(dialog.style.transform).toBe('translateY(100%)')
    restore()
  })

  it('settles a short slow pull back, and dismisses a short fast one', async () => {
    const restore = withNarrowViewport(true)
    const onClose = vi.fn()
    const { container } = sheet({ onClose })
    const dialog = dialogOf(container)
    await pull(screen.getByText('Kopf'), dialog, 40, 400)
    expect(dialog.style.transform).toBe('')
    expect(onClose).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)
    // the same distance flicked: speed carries it over on its own
    await pull(screen.getByText('Kopf'), dialog, 40, 20)
    expect(dialog.style.transform).toBe('translateY(100%)')
    restore()
  })

  it('derives the sheet from the width - wide dialogs cover a phone, max-w-md does not', () => {
    const wide = render(
      <Dialog onClose={() => {}} width="max-w-2xl">
        Inhalt
      </Dialog>,
    )
    expect(dialogOf(wide.container)).toHaveClass('dialog-sheet')
    const box = render(
      <Dialog onClose={() => {}} width="max-w-md">
        Inhalt
      </Dialog>,
    )
    expect(dialogOf(box.container)).not.toHaveClass('dialog-sheet')
  })

  it('honours an explicit sheet prop over the width default', () => {
    const { container } = render(
      <Dialog onClose={() => {}} width="max-w-2xl" sheet={false}>
        Inhalt
      </Dialog>,
    )
    expect(dialogOf(container)).not.toHaveClass('dialog-sheet')
  })

  // The sheet stops short of the top, so there IS a backdrop again - and it is
  // the dismissal everyone reaches for first. The grabber is the second
  // single-tap way out, which is what keeps the pull from being the only one
  // (WCAG 2.2 SC 2.5.1 / 2.5.7).
  it('a sheet closes on a backdrop click and on its grabber', async () => {
    const restore = withNarrowViewport(true)
    try {
      const onClose = vi.fn()
      const { container, unmount } = sheet({ onClose, closeLabel: 'Schließen' })
      clickBackdrop(dialogOf(container))
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      unmount()

      const second = vi.fn()
      sheet({ onClose: second, closeLabel: 'Schließen' })
      fireEvent.click(screen.getByRole('button', { name: 'Schließen' }))
      await waitFor(() => expect(second).toHaveBeenCalledTimes(1))
    } finally {
      restore()
    }
  })

  it('routes the sheet grabber through the unsaved guard', async () => {
    const restore = withNarrowViewport(true)
    try {
      const onClose = vi.fn()
      const onRequestClose = vi.fn(() => false)
      sheet({ onClose, onRequestClose, closeLabel: 'Schließen' })
      fireEvent.click(screen.getByRole('button', { name: 'Schließen' }))
      await waitFor(() => expect(onRequestClose).toHaveBeenCalledTimes(1))
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('keeps the backdrop click on a wide screen, where the backdrop is visible', async () => {
    const restore = withNarrowViewport(false)
    try {
      const onClose = vi.fn()
      const { container } = render(
        <Dialog onClose={onClose} width="max-w-2xl">
          Inhalt
        </Dialog>,
      )
      expect(screen.queryByRole('button', { name: 'Schließen' })).toBeNull()
      clickBackdrop(dialogOf(container))
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    } finally {
      restore()
    }
  })

  it('stays open when a dialog opened from inside it closes', async () => {
    // close/cancel do not bubble natively, but React walks them up its own tree
    const onOuter = vi.fn()
    const onInner = vi.fn()
    const { container } = render(
      <Dialog onClose={onOuter} onRequestClose={() => false} width="max-w-2xl">
        <Dialog onClose={onInner}>Auswahl</Dialog>
      </Dialog>,
    )
    const [outer, inner] = [...container.querySelectorAll('dialog')]
    inner.close()

    await waitFor(() => expect(onInner).toHaveBeenCalledTimes(1))
    expect(onOuter).not.toHaveBeenCalled()
    expect(outer.open).toBe(true)

    // and the outer one's own Escape still reaches its guard
    const cancel = new Event('cancel', { cancelable: true })
    fireEvent(outer, cancel)
    expect(cancel.defaultPrevented).toBe(true)
  })

  // ── the sheet's second height ──
  // A pull upwards asks for it, and a pull down from there gives the opening
  // height back rather than throwing the sheet away.
  it('opens the sheet to its full height when it is pulled up', async () => {
    const restore = withNarrowViewport(true)
    try {
      const { container } = sheet()
      const dialog = dialogOf(container)
      asScroller(screen.getByText('Inhalt'), 0)
      expect(dialog.hasAttribute('data-expanded')).toBe(false)

      await pull(screen.getByText('Inhalt'), dialog, -90)
      await waitFor(() => expect(dialog.hasAttribute('data-expanded')).toBe(true))
      expect(dialog.open).toBe(true)
    } finally {
      restore()
    }
  })

  // Nothing is decided under the finger: the sheet follows a pull up 1:1 and
  // only takes the full height once the finger lifts. Deciding mid-gesture
  // snapped it open while the thumb was still moving.
  it('follows a pull up and decides only when the finger lifts', async () => {
    const restore = withNarrowViewport(true)
    try {
      const { container } = sheet()
      const dialog = dialogOf(container)
      const body = screen.getByText('Inhalt')
      asScroller(body, 0)
      fireEvent.pointerDown(body, { clientY: 400, pointerId: 1 })
      fireEvent.pointerMove(dialog, { clientY: 360, pointerId: 1 })
      fireEvent.pointerMove(dialog, { clientY: 310, pointerId: 1 })
      expect(dialog.hasAttribute('data-expanded')).toBe(false)
      expect(dialog.style.transform).toBe('translate3d(0, -90px, 0)')
      await new Promise((r) => setTimeout(r, 300))
      fireEvent.pointerUp(dialog, { clientY: 310, pointerId: 1 })
      await waitFor(() => expect(dialog.hasAttribute('data-expanded')).toBe(true))
      // and the settle runs on the stylesheet's transition, which also moves
      // the height - an inline one naming only the transform left it out
      expect(dialog.style.transition).toBe('')
      expect(dialog.style.transform).toBe('')
    } finally {
      restore()
    }
  })

  it('gives the opening height back before it dismisses', async () => {
    const restore = withNarrowViewport(true)
    const onClose = vi.fn()
    try {
      const { container } = sheet({ onClose })
      const dialog = dialogOf(container)
      asScroller(screen.getByText('Inhalt'), 0)
      await pull(screen.getByText('Inhalt'), dialog, -90)
      await waitFor(() => expect(dialog.hasAttribute('data-expanded')).toBe(true))

      // first pull down: back to the opening height, still open
      await pull(screen.getByText('Inhalt'), dialog, 200)
      await waitFor(() => expect(dialog.hasAttribute('data-expanded')).toBe(false))
      expect(dialog.style.transform).not.toBe('translateY(100%)')
      expect(onClose).not.toHaveBeenCalled()

      // second pull down from there does dismiss
      await pull(screen.getByText('Inhalt'), dialog, 200)
      await waitFor(() => expect(dialog.style.transform).toBe('translateY(100%)'))
    } finally {
      restore()
    }
  })

  /** Give the sheet its two heights, so the hook can measure the difference:
   *  jsdom lays nothing out and reads 0 for both. 700 opening, 920 full. */
  const withHeights = (dialog: HTMLDialogElement) =>
    Object.defineProperty(dialog, 'clientHeight', {
      configurable: true,
      get: () => (dialog.hasAttribute('data-expanded') ? 920 : 700),
    })

  // One long pull from the full height is both steps in one: past the opening
  // height and a dismissal's distance beyond it, the sheet goes.
  it('dismisses on one long pull from the full height', async () => {
    const restore = withNarrowViewport(true)
    const onClose = vi.fn()
    try {
      const { container } = sheet({ onClose })
      const dialog = dialogOf(container)
      withHeights(dialog)
      asScroller(screen.getByText('Inhalt'), 0)
      await pull(screen.getByText('Inhalt'), dialog, -150)
      await waitFor(() => expect(dialog.hasAttribute('data-expanded')).toBe(true))

      // past the opening height (220) but short of a dismissal beyond it
      // (a quarter of 700): a step back
      await pull(screen.getByText('Inhalt'), dialog, 300, 800)
      await waitFor(() => expect(dialog.hasAttribute('data-expanded')).toBe(false))
      expect(dialog.style.transform).toBe('')

      await pull(screen.getByText('Inhalt'), dialog, -150)
      await waitFor(() => expect(dialog.hasAttribute('data-expanded')).toBe(true))
      // 220 + 175 and more: both pulls in one
      await pull(screen.getByText('Inhalt'), dialog, 420, 800)
      await waitFor(() => expect(dialog.style.transform).toBe('translateY(100%)'))
    } finally {
      restore()
    }
  })

  // The backdrop dims with the pull: the hook writes how far the sheet has
  // gone as a custom property the stylesheet reads on ::backdrop, and marks
  // the drag so the backdrop's own transition does not lag the finger.
  it('tells the backdrop how far the sheet is pulled, and only while it is', async () => {
    const restore = withNarrowViewport(true)
    try {
      const { container } = sheet()
      const dialog = dialogOf(container)
      withHeights(dialog)
      const body = screen.getByText('Inhalt')
      fireEvent.pointerDown(body, { clientY: 100, pointerId: 1 })
      fireEvent.pointerMove(dialog, { clientY: 200, pointerId: 1 })
      fireEvent.pointerMove(dialog, { clientY: 275, pointerId: 1 })
      expect(dialog.hasAttribute('data-dragging')).toBe(true)
      expect(dialog.style.getPropertyValue('--sheet-pull')).toBe('0.25')
      // slowly: 175px in 400ms would be a flick and dismiss
      await new Promise((r) => setTimeout(r, 800))
      fireEvent.pointerUp(dialog, { clientY: 275, pointerId: 1 })
      // a slow pull of a quarter is exactly the dismissal's edge, not past it
      await waitFor(() => expect(dialog.hasAttribute('data-dragging')).toBe(false))
      expect(dialog.style.getPropertyValue('--sheet-pull')).toBe('')
      expect(dialog.open).toBe(true)
    } finally {
      restore()
    }
  })

  // Reading past the first screenful is the content saying 70dvh was not
  // enough; the sheet takes the rest of the screen and the reader carries on.
  it('grows the sheet the first time its content is scrolled', async () => {
    const restore = withNarrowViewport(true)
    try {
      const { container } = sheet()
      const dialog = dialogOf(container)
      const body = screen.getByText('Inhalt')
      expect(dialog.hasAttribute('data-expanded')).toBe(false)

      asScroller(body, 120)
      fireEvent.scroll(body)
      await waitFor(() => expect(dialog.hasAttribute('data-expanded')).toBe(true))
    } finally {
      restore()
    }
  })

  it('leaves the sheet at its opening height while the content sits at the top', async () => {
    const restore = withNarrowViewport(true)
    try {
      const { container } = sheet()
      const dialog = dialogOf(container)
      const body = screen.getByText('Inhalt')

      asScroller(body, 0)
      fireEvent.scroll(body)
      await new Promise((r) => setTimeout(r, 20))
      expect(dialog.hasAttribute('data-expanded')).toBe(false)
    } finally {
      restore()
    }
  })

  it('never grows a centred dialog - there is no second height on a desktop', async () => {
    const restore = withNarrowViewport(false)
    try {
      const { container } = sheet()
      const dialog = dialogOf(container)
      const body = screen.getByText('Inhalt')

      asScroller(body, 120)
      fireEvent.scroll(body)
      await new Promise((r) => setTimeout(r, 20))
      expect(dialog.hasAttribute('data-expanded')).toBe(false)
    } finally {
      restore()
    }
  })

  it('leaves Escape to the platform when there is no guard', () => {
    // without onRequestClose no onCancel handler is attached at all, so the
    // browser's own Escape handling closes the dialog and onClose reports it
    const { container } = render(<Dialog onClose={() => {}}>Inhalt</Dialog>)
    const cancel = new Event('cancel', { cancelable: true })
    fireEvent(dialogOf(container), cancel)
    expect(cancel.defaultPrevented).toBe(false)
  })
})
