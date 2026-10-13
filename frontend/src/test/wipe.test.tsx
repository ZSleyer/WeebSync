import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enterPage, riseSteps, SectionHeading, Wipe, wipeOutMs } from 'fluid-lycoris'

afterEach(() => {
  vi.useRealTimers()
})

describe('wipeOutMs', () => {
  it('adds the stagger, caps it, and is instant without motion', () => {
    expect(wipeOutMs(0, false)).toBe(420)
    expect(wipeOutMs(2, false)).toBe(560)
    expect(wipeOutMs(40, false)).toBe(wipeOutMs(6, false))
    expect(wipeOutMs(3, true)).toBe(0)
  })
})

describe('Wipe', () => {
  it('stands still on the first render, plays out and hides, then plays in', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Wipe show>Live</Wipe>)
    const el = screen.getByText('Live')
    expect(el).toHaveClass('t-wipe')
    expect(el).not.toHaveAttribute('data-wipe')

    rerender(<Wipe show={false}>Live</Wipe>)
    expect(el).toHaveAttribute('data-wipe', 'out')
    expect(el).not.toHaveAttribute('hidden')
    act(() => {
      vi.advanceTimersByTime(420)
    })
    expect(el).toHaveAttribute('hidden')
    expect(el).not.toHaveAttribute('data-wipe')

    rerender(<Wipe show>Live</Wipe>)
    expect(el).toHaveAttribute('data-wipe', 'in')
    expect(el).not.toHaveAttribute('hidden')
  })

  it('plays the reveal on the first render when asked, with its stagger and colour', () => {
    render(
      <Wipe show appear index={2} color="var(--accent)">
        Neu
      </Wipe>,
    )
    const el = screen.getByText('Neu')
    expect(el).toHaveAttribute('data-wipe', 'in')
    expect(el.style.getPropertyValue('--i')).toBe('2')
    expect(el.style.getPropertyValue('--wipe-c')).toBe('var(--accent)')
  })

  it('starts hidden when not shown', () => {
    render(<Wipe show={false}>Weg</Wipe>)
    expect(screen.getByText('Weg')).toHaveAttribute('hidden')
  })
})

describe('riseSteps', () => {
  it('counts visible items up to the cap and starts off-screen ones at once', () => {
    expect(riseSteps([true, false, true, true])).toEqual([0, 0, 1, 2])
    const many = riseSteps(Array.from({ length: 40 }, () => true))
    expect(Math.max(...many)).toBe(14)
    expect(many.length).toBe(40)
  })
})

describe('enterPage', () => {
  it('marks the headings and rows, staggers them and replays on every call', () => {
    const { container } = render(
      <section>
        <SectionHeading title="Eins" />
        <SectionHeading title="Zwei" />
        <ul className="t-rows">
          <li className="t-row">a</li>
          <li className="t-row">b</li>
        </ul>
      </section>,
    )
    const root = container.firstElementChild as HTMLElement
    enterPage(root)
    expect(root).toHaveAttribute('data-wipe', 'in')
    const [one, two] = screen.getAllByRole('heading')
    expect(one.style.getPropertyValue('--i')).toBe('0')
    expect(two.style.getPropertyValue('--i')).toBe('1')
    const rows = root.querySelectorAll<HTMLElement>('.t-row')
    expect(rows[1].style.getPropertyValue('--ri')).toBe('1')

    root.dataset.wipe = 'done'
    enterPage(root)
    expect(root).toHaveAttribute('data-wipe', 'in')
  })
})
