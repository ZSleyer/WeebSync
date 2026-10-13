import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Segmented, segmentIndex, SettingsField, Switch } from 'fluid-lycoris'

const OPTS = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
  { value: 'c', label: 'C' },
]

describe('segmentIndex', () => {
  it('finds the picked option and says -1 for none', () => {
    expect(segmentIndex(OPTS, 'c')).toBe(2)
    expect(segmentIndex(OPTS, 'x')).toBe(-1)
  })
})

describe('Segmented thumb', () => {
  it('moves the thumb to the picked column and drops it when nothing is picked', () => {
    const { rerender } = render(<Segmented aria-label="S" value="b" onChange={() => {}} options={OPTS} />)
    const g = screen.getByRole('group', { name: 'S' })
    expect(g.style.getPropertyValue('--n')).toBe('3')
    expect(g.style.getPropertyValue('--i')).toBe('1')
    rerender(<Segmented aria-label="S" value="x" onChange={() => {}} options={OPTS} />)
    expect(g.querySelector('.t-seg-thumb')).toBeNull()
    expect(screen.getAllByRole('button').every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true)
  })
})

describe('Switch', () => {
  it('is a checkbox with the switch role, named by its label', () => {
    const onChange = vi.fn()
    render(<Switch label="Automatisch laden" checked={false} onChange={onChange} />)
    const sw = screen.getByRole('switch', { name: 'Automatisch laden' })
    expect(sw).toHaveClass('t-switch')
    expect(sw).not.toBeChecked()
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalled()
  })

  it('renders bare when there is no label', () => {
    const { container } = render(<Switch aria-label="An" />)
    expect(container.firstElementChild?.tagName).toBe('INPUT')
  })
})

describe('SettingsField', () => {
  it('names the control by its label and shows the hint and chip', () => {
    render(
      <SettingsField label="Port" htmlFor="port" hint="Standard 22" badge={<span>ENV</span>}>
        <input id="port" />
      </SettingsField>,
    )
    expect(screen.getByLabelText('Port')).toHaveAttribute('id', 'port')
    expect(screen.getByText('Standard 22')).toHaveClass('t-sf-h')
    expect(screen.getByText('ENV')).toBeInTheDocument()
  })

  it('lays a switch out as a row', () => {
    const { container } = render(
      <SettingsField label="An" row>
        <Switch aria-label="An" />
      </SettingsField>,
    )
    expect(container.firstElementChild).toHaveClass('t-sf', 't-sf--row')
  })
})
