import { fireEvent, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PageScroll from '../components/PageScroll'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

// jsdom's matchMedia matches nothing, so the component sees a phone
const page = (stacked: boolean) =>
  render(
    <div className="app-shell">
      <header>
        <span className="t-scroll-line" />
      </header>
      <main>
        <div>
          <header className="t-page-header">Titel</header>
        </div>
        <PageScroll stacked={stacked} />
      </main>
    </div>,
  )

describe('PageScroll', () => {
  it('docks the large title into the app bar once the page has scrolled past it', async () => {
    const { container } = page(false)
    const shell = container.querySelector('.app-shell')!
    const main = container.querySelector('main')!
    expect(shell).toHaveAttribute('data-large')
    expect(shell).not.toHaveAttribute('data-docked')
    main.scrollTop = 100
    fireEvent.scroll(main)
    await waitFor(() => expect(shell).toHaveAttribute('data-docked'))
    expect((container.querySelector('.t-page-header') as HTMLElement).style.getPropertyValue('--dock')).toBe('1.000')
  })

  it('leaves a stacked screen to its app bar title', () => {
    const { container } = page(true)
    const shell = container.querySelector('.app-shell')!
    expect(shell).toHaveAttribute('data-stacked')
    expect(shell).not.toHaveAttribute('data-large')
    expect(shell).toHaveAttribute('data-docked')
  })
})
