import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Menu, MenuItem, useMenu } from 'fluid-lycoris'

// The wrapper ref decides what counts as "inside", so the hook is exercised
// through the markup it is documented with: one element holding both the
// trigger and the list, and an unrelated control next to it.
let seenFocus: Element | null = null
function MenuHarness() {
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  return (
    <div>
      <div ref={ref} data-anchor={anchor} style={anchorStyle}>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          Sortieren
        </button>
        {open && (
          <Menu aria-label="Sortieren nach">
            <MenuItem
              selected
              onClick={() => {
                seenFocus = document.activeElement
              }}
            >
              Name
            </MenuItem>
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

  it('closes when something outside the wrapper scrolls', () => {
    render(<MenuHarness />)
    openMenu()
    fireEvent.scroll(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('stays open when the list itself scrolls', () => {
    render(<MenuHarness />)
    openMenu()
    fireEvent.scroll(screen.getByRole('listbox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('names an anchor per instance, as a dashed ident on the wrapper', () => {
    render(
      <>
        <MenuHarness />
        <MenuHarness />
      </>,
    )
    const names = Array.from(document.querySelectorAll<HTMLElement>('[data-anchor]')).map((el) => el.dataset.anchor!)
    expect(names).toHaveLength(2)
    expect(names[0]).not.toBe(names[1])
    for (const n of names) {
      expect(n).toMatch(/^--[A-Za-z0-9_-]+$/)
    }
    const wrapper = document.querySelector<HTMLElement>('[data-anchor]')!
    expect(wrapper.style.anchorName).toBe(names[0])
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

  it('hands the focus to the trigger before the chosen item acts, so a dialog gets it as opener', () => {
    render(<MenuHarness />)
    openMenu()
    const item = screen.getByRole('option', { name: 'Name' })
    item.focus()
    seenFocus = null
    fireEvent.click(item)
    const trigger = screen.getByRole('button', { name: 'Sortieren' })
    expect(seenFocus).toBe(trigger)
  })
})

function PickHarness() {
  const { open, setOpen, ref } = useMenu()
  return (
    <div ref={ref}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Mehr
      </button>
      {open && (
        <Menu kind="menu" aria-label="Mehr">
          <MenuItem onClick={() => {}}>Umschalten</MenuItem>
          <MenuItem aria-disabled onClick={() => {}}>
            Gesperrt
          </MenuItem>
          <MenuItem role="menuitemcheckbox" aria-checked={false} onClick={() => setOpen(false)}>
            Anpinnen
          </MenuItem>
          <MenuItem onClick={() => setOpen(false)}>Schließen</MenuItem>
        </Menu>
      )}
    </div>
  )
}

describe('useMenu focus after a pick', () => {
  const start = () => {
    render(<PickHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Mehr' }))
  }
  const settle = () => new Promise((r) => setTimeout(r, 10))

  it('keeps the focus on an item that leaves the menu open', async () => {
    start()
    for (const name of ['Umschalten', 'Gesperrt']) {
      const item = screen.getByRole('menuitem', { name })
      item.focus()
      fireEvent.click(item)
      await settle()
      expect(item).toHaveFocus()
    }
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('returns the focus to the trigger when the pick closes the menu, also for the Enter key', async () => {
    start()
    const item = screen.getByRole('menuitem', { name: 'Schließen' })
    item.focus()
    // Enter on a button is a click
    fireEvent.keyDown(item, { key: 'Enter' })
    fireEvent.click(item)
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Mehr' })).toHaveFocus()
  })

  it('treats menuitemcheckbox as an item too', async () => {
    start()
    const item = screen.getByRole('menuitemcheckbox', { name: 'Anpinnen' })
    item.focus()
    fireEvent.click(item)
    await settle()
    expect(screen.getByRole('button', { name: 'Mehr' })).toHaveFocus()
  })
})
