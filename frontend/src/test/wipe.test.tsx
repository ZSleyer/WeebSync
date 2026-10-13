import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enterPage, riseDelay, SectionHeading, Wipe, wipeOutMs } from 'fluid-lycoris'

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

describe('riseDelay', () => {
  it('grows from 0ms at the left edge to 260ms at the right, clamped', () => {
    expect(riseDelay(0, 1000)).toBe(0)
    expect(riseDelay(500, 1000)).toBe(130)
    expect(riseDelay(1000, 1000)).toBe(260)
    expect(riseDelay(-40, 1000)).toBe(0)
    expect(riseDelay(4000, 1000)).toBe(260)
    expect(riseDelay(10, 0)).toBe(0)
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
    // same place across the screen, same moment: the delay comes from x only
    expect(rows[0].style.getPropertyValue('--rd')).toBe('0ms')
    expect(rows[1].style.getPropertyValue('--rd')).toBe('0ms')

    root.dataset.wipe = 'done'
    enterPage(root)
    expect(root).toHaveAttribute('data-wipe', 'in')
  })
})
