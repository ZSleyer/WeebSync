import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import Logo from '../components/Logo'
import LogoIntro from '../components/LogoIntro'

describe('Logo', () => {
  it('carries a sheen only while something transfers', () => {
    const { container, rerender } = render(<Logo />)
    expect(container.querySelector('.t-logo-sheen')).toBeNull()
    rerender(<Logo active />)
    expect(container.querySelector('.t-logo-sheen')).not.toBeNull()
    expect(container.querySelector('svg')).toHaveAttribute('data-active')
  })
})

describe('LogoIntro', () => {
  afterEach(() => {
    delete document.documentElement.dataset.motion
  })

  it('plays on every mount, so a page change keyed by route redraws it', () => {
    const first = render(<LogoIntro intro="cut" />)
    expect(first.container.querySelector('[data-k="edge"]')).not.toBeNull()
    first.unmount()
    const again = render(<LogoIntro intro="cut" />)
    expect(again.container.querySelector('[data-k="edge"]')).not.toBeNull()
  })

  it('starts hidden, so the finished mark never flashes first', () => {
    const { container } = render(<LogoIntro intro="roll" />)
    // the first frame ran before paint: both letters sit below their places
    expect(container.querySelector('[data-k="gw"]')!.getAttribute('transform')).toBe('translate(0 640.0)')
  })

  it('is the plain mark, sheen included, with motion off', () => {
    document.documentElement.dataset.motion = 'off'
    const { container } = render(<LogoIntro active />)
    expect(container.querySelector('[data-k]')).toBeNull()
    expect(container.querySelector('.t-logo-sheen')).not.toBeNull()
  })
})
