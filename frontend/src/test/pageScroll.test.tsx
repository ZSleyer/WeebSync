import { fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import PageScroll from '../components/PageScroll'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

// jsdom's matchMedia matches nothing, so the component sees a phone
const page = (stacked: boolean, qc = new QueryClient(), title = true) =>
  render(
    <QueryClientProvider client={qc}>
      <div className="app-shell">
        <header>
          <span className="t-scroll-line" />
        </header>
        <main>
          <div>{title && <header className="t-page-header">Titel</header>}</div>
          <PageScroll stacked={stacked} />
        </main>
      </div>
    </QueryClientProvider>,
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
  // at the top of a top-level page a pull down brings the page along, and
  // letting go past the mark reloads what the page shows
  it('reloads the page on a pull from the top, and only past the mark', async () => {
    const qc = new QueryClient()
    const refetch = vi.spyOn(qc, 'refetchQueries').mockResolvedValue()
    const { container } = page(false, qc)
    const main = container.querySelector('main')!
    const content = main.firstElementChild as HTMLElement
    const pull = (dy: number) => {
      fireEvent.touchStart(main, { touches: [{ clientX: 100, clientY: 100 }] })
      fireEvent.touchMove(main, { touches: [{ clientX: 100, clientY: 110 }] })
      fireEvent.touchMove(main, { touches: [{ clientX: 100, clientY: 100 + dy }] })
      expect(content.style.transform).toBe(`translateY(${Math.min(96, dy / 2)}px)`)
      fireEvent.touchEnd(main, { changedTouches: [{ clientX: 100, clientY: 100 + dy }] })
    }
    pull(60)
    expect(refetch).not.toHaveBeenCalled()
    pull(200)
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1))
  })
  // Files has no large title; a pull there lists the folder again
  it('reloads a top-level page without a large title too', async () => {
    const qc = new QueryClient()
    const refetch = vi.spyOn(qc, 'refetchQueries').mockResolvedValue()
    const { container } = page(false, qc, false)
    const main = container.querySelector('main')!
    fireEvent.touchStart(main, { touches: [{ clientX: 100, clientY: 100 }] })
    fireEvent.touchMove(main, { touches: [{ clientX: 100, clientY: 110 }] })
    fireEvent.touchMove(main, { touches: [{ clientX: 100, clientY: 300 }] })
    fireEvent.touchEnd(main, { changedTouches: [{ clientX: 100, clientY: 300 }] })
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1))
  })
  // a dialog renders inside <main>: a drag in it is the dialog's, never a
  // pull on the page behind
  it('leaves a drag inside a dialog alone', async () => {
    const qc = new QueryClient()
    const refetch = vi.spyOn(qc, 'refetchQueries').mockResolvedValue()
    const { container } = page(false, qc)
    const main = container.querySelector('main')!
    const dialog = main.appendChild(document.createElement('dialog'))
    const inside = dialog.appendChild(document.createElement('p'))
    fireEvent.touchStart(inside, { touches: [{ clientX: 100, clientY: 100 }] })
    fireEvent.touchMove(inside, { touches: [{ clientX: 100, clientY: 110 }] })
    fireEvent.touchMove(inside, { touches: [{ clientX: 100, clientY: 300 }] })
    fireEvent.touchEnd(inside, { changedTouches: [{ clientX: 100, clientY: 300 }] })
    await new Promise((r) => setTimeout(r, 50))
    expect(refetch).not.toHaveBeenCalled()
    expect((main.firstElementChild as HTMLElement).style.transform).toBe('')
  })
  // Files scrolls its list in a box of its own: pulling that box back up
  // is a scroll, not a refresh
  it('leaves a scrolled inner box its own scroll', async () => {
    const qc = new QueryClient()
    const refetch = vi.spyOn(qc, 'refetchQueries').mockResolvedValue()
    const { container } = page(false, qc, false)
    const main = container.querySelector('main')!
    const box = main.firstElementChild!.appendChild(document.createElement('div'))
    Object.defineProperty(box, 'scrollHeight', { value: 2000 })
    Object.defineProperty(box, 'clientHeight', { value: 500 })
    box.scrollTop = 300
    fireEvent.touchStart(box, { touches: [{ clientX: 100, clientY: 100 }] })
    fireEvent.touchMove(box, { touches: [{ clientX: 100, clientY: 110 }] })
    fireEvent.touchMove(box, { touches: [{ clientX: 100, clientY: 300 }] })
    fireEvent.touchEnd(box, { changedTouches: [{ clientX: 100, clientY: 300 }] })
    await new Promise((r) => setTimeout(r, 50))
    expect(refetch).not.toHaveBeenCalled()
  })
})
