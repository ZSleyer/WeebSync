import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ActionMenu from '../components/ActionMenu'
import PillSelect from '../components/PillSelect'

describe('ActionMenu focus', () => {
  it('returns to the ⋯ button before the action runs, so a dialog it opens keeps it as opener', () => {
    let opener: Element | null = null
    const onClick = vi.fn(() => {
      opener = document.activeElement
    })
    render(<ActionMenu label="more" title="Row" actions={[{ key: 'a', label: 'Edit', onClick }]} />)
    const trigger = screen.getByRole('button', { name: 'more' })
    fireEvent.click(trigger)
    const item = screen.getByRole('menuitem', { name: 'Edit' })
    expect(document.activeElement).toBe(item)
    fireEvent.click(item)
    expect(onClick).toHaveBeenCalled()
    expect(opener).toBe(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('PillSelect keyboard (APG listbox popup)', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
    { value: 'c', label: 'Gamma' },
  ]
  const mount = (onChange = vi.fn()) => {
    render(<PillSelect value="b" options={options} onChange={onChange} label="Sort" />)
    return { trigger: screen.getByRole('button', { name: 'Sort' }), onChange }
  }

  it('opens on ArrowDown and focuses the chosen option', () => {
    const { trigger } = mount()
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Beta' }))
  })

  it('opens on ArrowUp too, and on click, with focus inside the list', () => {
    const { trigger } = mount()
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Beta' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Beta' }))
  })

  it('puts the focus back on the trigger after a choice', () => {
    const { trigger, onChange } = mount()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'Gamma' }))
    expect(onChange).toHaveBeenCalledWith('c')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on Tab, leaving the focus on the trigger so Tab moves on from there', () => {
    const { trigger } = mount()
    fireEvent.click(trigger)
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
