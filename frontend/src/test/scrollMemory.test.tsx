import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ScrollMemory from '../components/ScrollMemory'

// a phone: the wide query matches nothing
const shell = (initial: string) =>
  render(
    <MemoryRouter initialEntries={[initial]}>
      <div className="app-shell">
        <header className="ws-top" />
        <main>
          <section id="detected" />
        </main>
      </div>
      <ScrollMemory />
    </MemoryRouter>,
  )

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false })))
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('ScrollMemory on a phone', () => {
  it('puts the position back on <main> only, never on the document', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    sessionStorage.setItem('weebsync.scroll.default', '120')
    const { container } = shell('/')
    const main = container.querySelector('main')!
    await waitFor(() => expect(main.scrollTop).toBe(120))
    // moving the document slid the shell, and its top bar, out of view
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('scrolls to a #hash inside <main>, not through the document', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const into = vi.fn()
    Element.prototype.scrollIntoView = into
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { top: this.id === 'detected' ? 400 : 100, height: 10 } as DOMRect
    })
    const { container } = shell('/settings#detected')
    const main = container.querySelector('main')!
    await waitFor(() => expect(main.scrollTop).toBe(300))
    expect(into).not.toHaveBeenCalled()
    expect(scrollTo).not.toHaveBeenCalled()
  })
})

describe('ScrollMemory with blocked storage', () => {
  it('survives a sessionStorage that throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(() => shell('/')).not.toThrow()
  })
})
