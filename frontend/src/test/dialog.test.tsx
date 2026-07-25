import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      <Dialog onClose={() => {}} width="max-w-2xl" aria-label="Watch bearbeiten" bodyClassName="max-h-[85vh]" danger>
        Inhalt
      </Dialog>,
    )
    const dialog = dialogOf(container)
    expect(dialog).toHaveClass('w-full', 'p-0', 'max-w-2xl')
    expect(dialog).toHaveAttribute('aria-label', 'Watch bearbeiten')
    expect(dialog.firstElementChild).toHaveClass('flex', 'flex-col', 't-panel--danger', 'max-h-[85vh]')
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

  it('leaves Escape to the platform when there is no guard', () => {
    // without onRequestClose no onCancel handler is attached at all, so the
    // browser's own Escape handling closes the dialog and onClose reports it
    const { container } = render(<Dialog onClose={() => {}}>Inhalt</Dialog>)
    const cancel = new Event('cancel', { cancelable: true })
    fireEvent(dialogOf(container), cancel)
    expect(cancel.defaultPrevented).toBe(false)
  })
})
