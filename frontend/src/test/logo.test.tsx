import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import Logo from '../components/Logo'

const at = (c: HTMLElement, k: string) => c.querySelector(`[data-k="${k}"]`)!

describe('Logo', () => {
  afterEach(() => {
    delete document.documentElement.dataset.motion
  })

  it('carries a sheen only while something transfers', () => {
    const { container, rerender } = render(<Logo intro="cut" />)
    expect(container.querySelector('.t-logo-sheen')).toBeNull()
    rerender(<Logo intro="cut" active />)
    expect(container.querySelector('.t-logo-sheen')).not.toBeNull()
    expect(container.querySelector('svg')).toHaveAttribute('data-active')
  })

  it('starts hidden, so the finished mark never flashes first', () => {
    const { container } = render(<Logo intro="roll" />)
    // the first frame ran before paint: both letters sit below their places
    expect(at(container, 'gw').getAttribute('transform')).toBe('translate(0 640.0)')
  })

  it('replays on a new key without remounting', () => {
    const { container, rerender } = render(<Logo intro="roll" replayKey="/a" />)
    const svg = container.querySelector('svg')
    at(container, 'gw').setAttribute('transform', 'translate(0 0)') // as if it had landed
    rerender(<Logo intro="roll" replayKey="/b" />)
    expect(container.querySelector('svg')).toBe(svg)
    expect(at(container, 'gw').getAttribute('transform')).toBe('translate(0 640.0)')
  })

  it('is the plain mark with motion off', () => {
    document.documentElement.dataset.motion = 'off'
    const { container } = render(<Logo intro="roll" />)
    expect(at(container, 'gw').getAttribute('transform')).toBeNull()
    expect(at(container, 'wipe').getAttribute('points')).toContain('1400')
  })
})
