import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MediaDetail from '../components/MediaDetail'
import type { Media } from '../api'

const media = { id: 1, title: { romaji: 'Demo' }, episodes: 12, trailer: { site: 'youtube', id: 'abc' } } as Media

describe('MediaDetail trailer focus', () => {
  it('takes the focus once when it starts, not on every later render', () => {
    const page = (now: number) => (
      <>
        <input aria-label="progress" />
        <MediaDetail media={media} now={now} />
      </>
    )
    const { container, rerender } = render(page(0))
    fireEvent.click(screen.getByRole('button', { name: 'remote.trailerPlay' }))
    const frame = container.querySelector('iframe')!
    expect(frame).toHaveFocus()
    const input = screen.getByLabelText('progress')
    input.focus()
    rerender(page(60_000))
    rerender(page(120_000))
    expect(input).toHaveFocus()
  })
})
