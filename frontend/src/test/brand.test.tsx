import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Brand from '../components/Brand'

const shown = (els: NodeListOf<Element>) => [...els].map((e) => (e as HTMLElement).style.opacity)

describe('Brand', () => {
  it('rests on the wordmark alone where it cannot move, no letter posed', () => {
    const { container } = render(<Brand variant="rail" slogan="かしら" replayKey="/" />)
    expect(container.querySelector('[role="img"]')).toHaveAccessibleName('WeebSync')
    expect(shown(container.querySelectorAll('[data-ch]'))).toEqual(Array(8).fill('1'))
    // no letter stands in its mark pose
    expect([...container.querySelectorAll<HTMLElement>('[data-ch]')].map((e) => e.style.transform)).toEqual(
      Array(8).fill(''),
    )
    // the slogan is text under the wordmark, or ruby drawn by CSS over it (no
    // text node, so it never joins the link's name): either way it reads かしら
    const slogan = container.querySelector<HTMLElement>('[data-slogan]')!
    const drawn = [...slogan.querySelectorAll<HTMLElement>('[data-c]')].map((e) => e.dataset.c).join('')
    expect(slogan.textContent || drawn).toBe('かしら')
  })

  it('shows the wordmark alone on the about page', () => {
    const { container } = render(<Brand variant="about" slogan="かしら" />)
    expect(container.querySelector('.t-logo')).toBeNull()
    expect(container.querySelectorAll('[data-ch]')).toHaveLength(8)
  })

  it('carries no slogan when none is given', () => {
    const { container } = render(<Brand variant="hero" />)
    expect(container.querySelector('[data-slogan]')).toBeNull()
  })
})
