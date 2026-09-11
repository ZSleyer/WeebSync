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
    expect(dialog.firstElementChild).toHaveClass('flex', 'flex-col', 'overflow-y-auto', 't-panel--danger', 'dialog-body')
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

  // ── full-screen sheet on phones ──
  // jsdom's matchMedia always reports `matches: false`, so the narrow case is
  // stubbed. Restored per test, since the component reads it on first render.
  const withNarrowViewport = (matches: boolean) => {
    const real = window.matchMedia
    window.matchMedia = ((q: string) =>
      ({ matches, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    return () => {
      window.matchMedia = real
    }
  }

  // the pull-down: pointer events on the header, distances in clientY
  const pull = (header: HTMLElement, dialog: HTMLDialogElement, dy: number) => {
    fireEvent.pointerDown(header, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(dialog, { clientY: 100 + dy / 2, pointerId: 1 })
    fireEvent.pointerMove(dialog, { clientY: 100 + dy, pointerId: 1 })
    fireEvent.pointerUp(dialog, { clientY: 100 + dy, pointerId: 1 })
  }

  it('closes a sheet pulled down by its header', async () => {
    const restore = withNarrowViewport(true)
    const onClose = vi.fn()
    const { container } = render(
      <Dialog onClose={onClose} width="max-w-2xl">
        <div className="dialog-body">
          <header>Kopf</header>
          <p>Inhalt</p>
        </div>
      </Dialog>,
    )
    const dialog = dialogOf(container)
    pull(screen.getByText('Kopf'), dialog, 200)
    // the sheet slides out first; the close waits for the transition
    await waitFor(() => expect(dialog.style.transform).toBe('translateY(100%)'))
    fireEvent.transitionEnd(dialog)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    restore()
  })

  it('settles a short pull back and a pull on the body does nothing', () => {
    const restore = withNarrowViewport(true)
    const onClose = vi.fn()
    const { container } = render(
      <Dialog onClose={onClose} width="max-w-2xl">
        <div className="dialog-body">
          <header>Kopf</header>
          <p>Inhalt</p>
        </div>
      </Dialog>,
    )
    const dialog = dialogOf(container)
    pull(screen.getByText('Kopf'), dialog, 60)
    expect(dialog.style.transform).toBe('')
    pull(screen.getByText('Inhalt'), dialog, 300)
    expect(dialog.style.transform).toBe('')
    expect(onClose).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)
    restore()
  })

  it('derives the sheet from the width - wide dialogs cover a phone, max-w-md does not', () => {
    const wide = render(<Dialog onClose={() => {}} width="max-w-2xl">Inhalt</Dialog>)
    expect(dialogOf(wide.container)).toHaveClass('dialog-sheet')
    const box = render(<Dialog onClose={() => {}} width="max-w-md">Inhalt</Dialog>)
    expect(dialogOf(box.container)).not.toHaveClass('dialog-sheet')
  })

  it('honours an explicit sheet prop over the width default', () => {
    const { container } = render(<Dialog onClose={() => {}} width="max-w-2xl" sheet={false}>Inhalt</Dialog>)
    expect(dialogOf(container)).not.toHaveClass('dialog-sheet')
  })

  it('a sheet on a phone offers a close button instead of a backdrop click', async () => {
    const restore = withNarrowViewport(true)
    try {
      const onClose = vi.fn()
      const { container } = render(
        <Dialog onClose={onClose} width="max-w-2xl" closeLabel="Schließen">
          Inhalt
        </Dialog>,
      )
      const dialog = dialogOf(container)
      // there is no visible backdrop to aim at, so a click on the dialog box
      // must not close it - that would fire on any tap next to the content
      clickBackdrop(dialog)
      expect(onClose).not.toHaveBeenCalled()
      expect(dialog.open).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: 'Schließen' }))
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    } finally {
      restore()
    }
  })

  it('routes the sheet close button through the unsaved guard', async () => {
    const restore = withNarrowViewport(true)
    try {
      const onClose = vi.fn()
      const onRequestClose = vi.fn(() => false)
      render(
        <Dialog onClose={onClose} onRequestClose={onRequestClose} width="max-w-2xl" closeLabel="Schließen">
          Inhalt
        </Dialog>,
      )
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
      const { container } = render(<Dialog onClose={onClose} width="max-w-2xl">Inhalt</Dialog>)
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

  it('leaves Escape to the platform when there is no guard', () => {
    // without onRequestClose no onCancel handler is attached at all, so the
    // browser's own Escape handling closes the dialog and onClose reports it
    const { container } = render(<Dialog onClose={() => {}}>Inhalt</Dialog>)
    const cancel = new Event('cancel', { cancelable: true })
    fireEvent(dialogOf(container), cancel)
    expect(cancel.defaultPrevented).toBe(false)
  })
})
