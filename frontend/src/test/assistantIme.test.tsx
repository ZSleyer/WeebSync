import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import Assistant from '../pages/Assistant'
import { api } from '../api'
import { SeriesModalProvider } from '../components/SeriesModal'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }) as never,
}))

// jsdom has no scrolling
Element.prototype.scrollTo = () => {}

afterEach(() => vi.restoreAllMocks())

function setup() {
  vi.spyOn(api, 'get').mockResolvedValue([])
  vi.spyOn(api, 'post').mockReturnValue(new Promise(() => {}))
  vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}))
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SeriesModalProvider>
          <Assistant />
        </SeriesModalProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const box = screen.getByPlaceholderText('assistant.placeholder') as HTMLTextAreaElement
  fireEvent.change(box, { target: { value: 'ワンピース' } })
  return box
}

describe('Assistant composer', () => {
  it('does not send when Enter confirms an IME composition', () => {
    const box = setup()
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    // Safari reports the confirming Enter after compositionend, as keyCode 229
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
    expect(box.value).toBe('ワンピース')
  })

  it('sends on a plain Enter', () => {
    const box = setup()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('')
  })
})
