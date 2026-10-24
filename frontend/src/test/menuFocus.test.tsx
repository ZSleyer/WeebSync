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

  it('opens on click on the chosen option', () => {
    const { trigger } = mount()
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Beta' }))
  })

  it('opens on ArrowUp and Home at the first option, on End at the last', () => {
    for (const [key, name] of [
      ['ArrowUp', 'Alpha'],
      ['Home', 'Alpha'],
      ['End', 'Gamma'],
    ]) {
      const { unmount } = render(<PillSelect value="b" options={options} onChange={vi.fn()} label="Sort" />)
      fireEvent.keyDown(screen.getByRole('button', { name: 'Sort' }), { key })
      expect(document.activeElement).toBe(screen.getByRole('option', { name }))
      unmount()
    }
  })

  it('stops at the ends of the list instead of wrapping', () => {
    const { trigger } = mount()
    fireEvent.keyDown(trigger, { key: 'Home' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Alpha' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Gamma' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
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

  it('selects the focused option on Tab, closes and leaves the focus on the trigger', () => {
    const { trigger, onChange } = mount()
    fireEvent.click(trigger)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(onChange).toHaveBeenCalledWith('c')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
