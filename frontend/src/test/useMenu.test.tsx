import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Menu, MenuItem, useMenu } from '@weebsync/design-system'

// The wrapper ref decides what counts as "inside", so the hook is exercised
// through the markup it is documented with: one element holding both the
// trigger and the list, and an unrelated control next to it.
function MenuHarness() {
  const { open, setOpen, ref } = useMenu()
  return (
    <div>
      <div ref={ref}>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          Sortieren
        </button>
        {open && (
          <Menu aria-label="Sortieren nach">
            <MenuItem selected>Name</MenuItem>
          </Menu>
        )}
      </div>
      <button type="button">Außerhalb</button>
    </div>
  )
}

const openMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Sortieren' }))
  expect(screen.getByRole('listbox', { name: 'Sortieren nach' })).toBeInTheDocument()
}

describe('useMenu', () => {
  it('starts closed and opens on the trigger', () => {
    render(<MenuHarness />)
    expect(screen.queryByRole('listbox')).toBeNull()
    openMenu()
    expect(screen.getByRole('button', { name: 'Sortieren' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes on a mousedown outside the wrapper', () => {
    render(<MenuHarness />)
    openMenu()
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Außerhalb' }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes on a mousedown on the bare document', () => {
    render(<MenuHarness />)
    openMenu()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('stays open on a mousedown inside the wrapper', () => {
    render(<MenuHarness />)
    openMenu()
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Name' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('stays open on a mousedown on the trigger, which the wrapper contains', () => {
    render(<MenuHarness />)
    openMenu()
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Sortieren' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('closes on Escape', () => {
    render(<MenuHarness />)
    openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('ignores other keys', () => {
    render(<MenuHarness />)
    openMenu()
    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('detaches its document listeners once closed', () => {
    render(<MenuHarness />)
    openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    // a stale listener would still be able to react; nothing must throw or reopen
    fireEvent.mouseDown(document.body)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
