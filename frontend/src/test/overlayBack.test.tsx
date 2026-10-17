import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, Menu, MenuItem, useMenu } from 'fluid-lycoris'
import { Hint } from '../components/RenameOptions'
import { usePlayerMenuBack } from '../pages/playerMenuBack'

// The back gesture on Android (and Escape) reaches a page as a CloseWatcher's
// close event. The fake keeps the stack the platform keeps: the latest
// watcher is the first to be asked.
class FakeWatcher {
  static stack: FakeWatcher[] = []
  onclose: (() => void) | null = null
  constructor() {
    FakeWatcher.stack.push(this)
  }
  destroy() {
    FakeWatcher.stack = FakeWatcher.stack.filter((w) => w !== this)
  }
  static back() {
    const top = FakeWatcher.stack.at(-1)
    top?.onclose?.()
    top?.destroy()
  }
}
beforeEach(() => {
  FakeWatcher.stack = []
  vi.stubGlobal('CloseWatcher', FakeWatcher)
})
afterEach(() => vi.unstubAllGlobals())

function MenuHarness() {
  const { open, setOpen, ref } = useMenu()
  return (
    <div ref={ref}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Sortieren
      </button>
      {open && (
        <Menu aria-label="Sortieren nach">
          <MenuItem>Name</MenuItem>
        </Menu>
      )}
    </div>
  )
}

describe('back closes the topmost transient overlay', () => {
  it('a menu', () => {
    render(<MenuHarness />)
    expect(FakeWatcher.stack).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Sortieren' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(FakeWatcher.stack).toHaveLength(1)
    act(() => FakeWatcher.back())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(FakeWatcher.stack).toHaveLength(0)
  })

  it('a menu closed some other way gives its watcher back', () => {
    render(<MenuHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Sortieren' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sortieren' }))
    expect(FakeWatcher.stack).toHaveLength(0)
  })

  it('a menu inside a dialog closes before the dialog', () => {
    const onClose = vi.fn()
    render(
      <Dialog onClose={onClose}>
        <MenuHarness />
      </Dialog>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sortieren' }))
    act(() => FakeWatcher.back())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a tooltip held open by focus', () => {
    render(<Hint text="Erklärung" />)
    fireEvent.focus(screen.getByRole('button', { name: 'Erklärung' }))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    expect(FakeWatcher.stack).toHaveLength(1)
    act(() => FakeWatcher.back())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('the latest player menu first, a submenu before the menu it came from', () => {
    const settings = document.createElement('media-settings-menu')
    const sub = document.createElement('media-chrome-menu')
    document.body.append(settings, sub)
    settings.hidden = false
    sub.hidden = false
    renderHook(() => usePlayerMenuBack())
    const toggle = (el: HTMLElement, newState: string) => {
      act(() => {
        const e = new Event('toggle', { bubbles: true })
        Object.assign(e, { newState })
        el.dispatchEvent(e)
      })
    }
    toggle(settings, 'open')
    toggle(sub, 'open')
    expect(FakeWatcher.stack).toHaveLength(1)
    act(() => FakeWatcher.back())
    expect(sub.hidden).toBe(true)
    expect(settings.hidden).toBe(false)
    // media-chrome reports the close; the settings menu is next
    toggle(sub, 'closed')
    act(() => FakeWatcher.back())
    expect(settings.hidden).toBe(true)
    toggle(settings, 'closed')
    expect(FakeWatcher.stack).toHaveLength(0)
    settings.remove()
    sub.remove()
  })

  it('does nothing where the browser has no CloseWatcher', () => {
    vi.stubGlobal('CloseWatcher', undefined)
    render(<MenuHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Sortieren' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })
})
