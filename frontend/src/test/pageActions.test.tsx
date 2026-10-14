import { render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import PageActions, { AppBarActions, PageToolbar, ShellToolbar, TitleActions } from '../components/PageActions'

const real = window.matchMedia
const width = (wide: boolean) => {
  window.matchMedia = ((q: string) => ({
    matches: wide,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia
}
afterEach(() => {
  window.matchMedia = real
})

// the shell's slots, held in state the way the shell holds them
function Shell({ titleRow }: { titleRow: boolean }) {
  const [bar, setBar] = useState<HTMLElement | null>(null)
  const [title, setTitle] = useState<HTMLElement | null>(null)
  const [tool, setTool] = useState<HTMLElement | null>(null)
  return (
    <AppBarActions.Provider value={bar}>
      <TitleActions.Provider value={titleRow ? title : undefined}>
        <ShellToolbar.Provider value={tool}>
          <div data-slot="bar" ref={setBar} />
          <div data-slot="title" ref={setTitle} />
          <main>
            <PageActions>
              <button type="button">trash</button>
            </PageActions>
            <PageToolbar>
              <div role="toolbar">selection</div>
            </PageToolbar>
          </main>
          <div data-slot="tool" ref={setTool} />
        </ShellToolbar.Provider>
      </TitleActions.Provider>
    </AppBarActions.Provider>
  )
}

const where = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll('[data-slot], main')].find((n) => [...n.children].some((ch) => ch.textContent === text)) as
    | HTMLElement
    | undefined

describe('page slots', () => {
  it('put the actions in the app bar and the toolbar in place of the tabs on a phone', () => {
    width(false)
    const { container } = render(<Shell titleRow={false} />)
    expect(where(container, 'trash')?.dataset.slot).toBe('bar')
    expect(where(container, 'selection')?.dataset.slot).toBe('tool')
  })

  it('put the actions in the desktop title row, inline where there is none', () => {
    width(true)
    const { container, unmount } = render(<Shell titleRow />)
    expect(where(container, 'trash')?.dataset.slot).toBe('title')
    // the toolbar renders where the page puts it
    expect(where(container, 'selection')?.tagName).toBe('MAIN')
    unmount()
    const stacked = render(<Shell titleRow={false} />)
    expect(where(stacked.container, 'trash')?.tagName).toBe('MAIN')
  })
})
