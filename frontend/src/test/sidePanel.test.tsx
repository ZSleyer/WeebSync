import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SidePanel } from '@weebsync/design-system'

describe('SidePanel', () => {
  it('is a non-modal named dialog that takes focus and gives it back', () => {
    const { rerender } = render(<button>Poster</button>)
    screen.getByRole('button', { name: 'Poster' }).focus()
    rerender(
      <>
        <button>Poster</button>
        <SidePanel aria-label="Details" onRequestClose={() => {}}>
          <p>Inhalt</p>
        </SidePanel>
      </>,
    )
    const panel = screen.getByRole('dialog', { name: 'Details' })
    expect(panel).toHaveAttribute('aria-modal', 'false')
    expect(panel).toHaveFocus()
    rerender(<button>Poster</button>)
    expect(screen.getByRole('button', { name: 'Poster' })).toHaveFocus()
  })

  it('closes on Escape from inside, but leaves it to an open menu', () => {
    const close = vi.fn()
    render(
      <SidePanel aria-label="Details" onRequestClose={close}>
        <button aria-haspopup="menu" aria-expanded="false">
          Mehr
        </button>
      </SidePanel>,
    )
    const more = screen.getByRole('button', { name: 'Mehr' })
    more.setAttribute('aria-expanded', 'true')
    fireEvent.keyDown(more, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
    more.setAttribute('aria-expanded', 'false')
    fireEvent.keyDown(more, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
