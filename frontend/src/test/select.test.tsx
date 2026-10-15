import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { listPosition, Select, selectOptions, stepOption, typeAhead } from 'fluid-lycoris'

const OPTS = selectOptions(
  <>
    <option value="a">Alpha</option>
    <option value="b" disabled>
      Beta
    </option>
    {['Gamma', 'Gold'].map((x) => (
      <option key={x} value={x.toLowerCase()}>
        {x}
      </option>
    ))}
    <optgroup label="g">
      <option>Delta</option>
    </optgroup>
    {null}
  </>,
)

describe('selectOptions', () => {
  it('collects options through fragments, arrays and groups, taking the text as a missing value', () => {
    expect(OPTS.map((o) => o.value)).toEqual(['a', 'b', 'gamma', 'gold', 'Delta'])
    expect(OPTS[1].disabled).toBe(true)
    expect(OPTS[4].text).toBe('Delta')
  })
})

describe('stepOption', () => {
  it('skips disabled options and stays put at the ends', () => {
    expect(stepOption(OPTS, 0, 1)).toBe(2)
    expect(stepOption(OPTS, 2, -1)).toBe(0)
    expect(stepOption(OPTS, 0, -1)).toBe(0)
    expect(stepOption(OPTS, 4, 1)).toBe(4)
  })
})

describe('typeAhead', () => {
  it('finds by prefix, cycles a repeated letter and skips disabled ones', () => {
    expect(typeAhead(OPTS, 0, 'g')).toBe(2)
    expect(typeAhead(OPTS, 2, 'g')).toBe(3)
    expect(typeAhead(OPTS, 3, 'g')).toBe(2)
    expect(typeAhead(OPTS, 0, 'go')).toBe(3)
    expect(typeAhead(OPTS, 0, 'b')).toBe(-1)
  })
})

function setup(props: Partial<Parameters<typeof Select>[0]> = {}) {
  const onChange = vi.fn()
  render(
    <Select aria-label="Quelle" value="a" onChange={onChange} {...props}>
      <option value="a">Alpha</option>
      <option value="b" disabled>
        Beta
      </option>
      <option value="c">Gamma</option>
    </Select>,
  )
  return { onChange, trigger: screen.getByRole('combobox', { name: 'Quelle' }) }
}

describe('Select', () => {
  it('opens on a click with the picked option marked, and picks with the mouse', () => {
    const { onChange, trigger } = setup()
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('option', { name: 'Gamma' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ value: 'c' }) }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('walks with the arrows past disabled options and picks with Enter, focus staying on the trigger', () => {
    const { onChange, trigger } = setup()
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const active = trigger.getAttribute('aria-activedescendant')
    expect(document.getElementById(active!)).toHaveTextContent('Gamma')
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange.mock.calls[0][0].target.value).toBe('c')
    expect(document.activeElement).toBe(trigger)
  })

  it('jumps by typing and with Home and End, and closes on Escape without a change', () => {
    const { onChange, trigger } = setup()
    fireEvent.keyDown(trigger, { key: 'g' })
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)).toHaveTextContent('Gamma')
    fireEvent.keyDown(trigger, { key: 'Home' })
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)).toHaveTextContent('Alpha')
    fireEvent.keyDown(trigger, { key: 'End' })
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)).toHaveTextContent('Gamma')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('carries its value into a form through a hidden field when uncontrolled', () => {
    const { container } = render(
      <form>
        <Select aria-label="Protokoll" name="protocol" defaultValue="ftps">
          <option value="sftp">SFTP</option>
          <option value="ftps">FTPS</option>
        </Select>
      </form>,
    )
    const form = container.querySelector('form')!
    expect(new FormData(form).get('protocol')).toBe('ftps')
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: 'SFTP' }))
    expect(new FormData(form).get('protocol')).toBe('sftp')
    expect(screen.getByRole('combobox')).toHaveTextContent('SFTP')
  })

  it('stays shut when disabled', () => {
    const { trigger } = setup({ disabled: true })
    expect(trigger).toBeDisabled()
  })
})

describe('listPosition', () => {
  const trigger = { left: 20, top: 500, bottom: 544, width: 200 }
  it('hangs under the trigger when it fits', () => {
    expect(listPosition(trigger, 150, 900)).toEqual({ left: 20, top: 548, minWidth: 200 })
  })
  it('opens upward when there is no room below but more above', () => {
    expect(listPosition(trigger, 400, 700)).toEqual({ left: 20, top: 96, minWidth: 200 })
  })
})

describe('Select hidden options', () => {
  it('shows a hidden prompt as the value but never lists it or lets the keys reach it', () => {
    render(
      <Select aria-label="Server" value="" onChange={() => {}}>
        <option value="" hidden>
          Choose one
        </option>
        <option value="plex">Plex</option>
        <option value="jellyfin">Jellyfin</option>
      </Select>,
    )
    const trigger = screen.getByRole('combobox')
    expect(trigger).toHaveTextContent('Choose one')
    fireEvent.click(trigger)
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Plex', 'Jellyfin'])
    expect(stepOption(selectOptions(<option hidden>x</option>), -1, 1)).toBe(-1)
  })
})

describe('Select names its list', () => {
  it('mirrors the trigger label onto the listbox when there is no id', () => {
    render(
      <Select aria-label="Sprache" value="de" onChange={() => {}}>
        <option value="de">Deutsch</option>
      </Select>,
    )
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox', { name: 'Sprache' })).toBeInTheDocument()
  })
})
