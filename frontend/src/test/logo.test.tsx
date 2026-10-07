import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
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
  beforeEach(() => sessionStorage.clear())

  it('plays once per session, then stands as the plain mark', () => {
    const first = render(<LogoIntro intro="cut" />)
    expect(first.container.querySelector('[data-k="edge"]')).not.toBeNull()
    expect(sessionStorage.getItem('weebsync.logo-intro')).toBe('1')
    first.unmount()

    const again = render(<LogoIntro intro="cut" />)
    expect(again.container.querySelector('[data-k]')).toBeNull()
    expect(again.container.querySelectorAll('path')).toHaveLength(2)
  })

  it('starts hidden, so the finished mark never flashes first', () => {
    const { container } = render(<LogoIntro intro="roll" />)
    // the first frame ran before paint: both letters sit below their places
    expect(container.querySelector('[data-k="gw"]')!.getAttribute('transform')).toBe('translate(0 640.0)')
  })
})
