import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Logo from '../components/Logo'

describe('Logo', () => {
  it('carries a sheen only while something transfers', () => {
    const { container, rerender } = render(<Logo />)
    expect(container.querySelector('.t-logo-sheen')).toBeNull()
    rerender(<Logo active />)
    expect(container.querySelector('.t-logo-sheen')).not.toBeNull()
    expect(container.querySelector('svg')).toHaveAttribute('data-active')
  })
})
