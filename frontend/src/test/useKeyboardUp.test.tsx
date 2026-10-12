import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useKeyboardUp } from '../hooks'

function Probe() {
  const up = useKeyboardUp()
  return (
    <>
      <input aria-label="field" />
      <output>{up ? 'up' : 'down'}</output>
    </>
  )
}

const resize = (h: number) =>
  act(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: h })
    window.dispatchEvent(new Event('resize'))
  })

describe('useKeyboardUp', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is up while a field has focus and the viewport has shrunk, down once the keyboard closes', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    resize(800)
    const { getByLabelText, getByRole } = render(<Probe />)
    act(() => getByLabelText('field').focus())
    expect(getByRole('status').textContent).toBe('down')
    resize(450)
    expect(getByRole('status').textContent).toBe('up')
    // Android's back gesture: the keyboard goes, the focus stays
    resize(800)
    expect(getByRole('status').textContent).toBe('down')
  })
})
