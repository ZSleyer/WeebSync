import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Brand from '../components/Brand'

const shown = (els: NodeListOf<Element>) => [...els].map((e) => (e as HTMLElement).style.opacity)

describe('Brand', () => {
  it('rests on the wordmark alone where it cannot move, mark hidden', () => {
    const { container } = render(<Brand variant="rail" slogan="かしら" replayKey="/" />)
    expect(container.querySelector('[role="img"]')).toHaveAccessibleName('WeebSync')
    expect(shown(container.querySelectorAll('[data-ch]'))).toEqual(Array(8).fill('1'))
    expect(shown(container.querySelectorAll('[data-half]'))).toEqual(['0', '0'])
    expect(container.querySelector('[data-slogan]')).toHaveTextContent('かしら')
  })

  it('shows mark and wordmark together only on the about page', () => {
    const { container } = render(<Brand variant="about" slogan="かしら" />)
    expect(container.querySelector('.t-logo')).not.toBeNull()
    expect(container.querySelectorAll('[data-ch]')).toHaveLength(8)
  })

  it('carries no slogan when none is given', () => {
    const { container } = render(<Brand variant="hero" />)
    expect(container.querySelector('[data-slogan]')).toBeNull()
  })
})
