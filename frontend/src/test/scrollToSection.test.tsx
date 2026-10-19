import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { scrollToSection } from '../components/ScrollMemory'

// a phone: the wide query matches nothing
beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false })))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

it('scrolls <main> by the rect delta and leaves the window alone', () => {
  document.body.innerHTML = '<div class="app-shell"><main><section id="s"></section></main></div>'
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const into = vi.fn()
  Element.prototype.scrollIntoView = into
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { top: this.id === 's' ? 500 : 80 } as DOMRect
  })
  scrollToSection(document.getElementById('s')!)
  expect(document.querySelector('main')!.scrollTop).toBe(420)
  expect(scrollTo).not.toHaveBeenCalled()
  expect(into).not.toHaveBeenCalled()
})
