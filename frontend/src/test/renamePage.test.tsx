import { useState, type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import Rename from '../pages/Rename'
import { api, type Entry } from '../api'
import { ShellFooter } from '../components/PageActions'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) as never,
}))

const dir = (name: string, path: string): Entry => ({
  name,
  path,
  isDir: true,
  size: 0,
  modTime: '2026-09-01T00:00:00Z',
})

function Shell({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  return (
    <ShellFooter.Provider value={node}>
      <div ref={setNode} />
      {children}
    </ShellFooter.Provider>
  )
}

function mount() {
  vi.spyOn(api, 'get').mockImplementation(async (u: string) => {
    if (u.startsWith('/api/browse/local')) {
      const p = new URLSearchParams(u.split('?')[1] ?? '').get('path') ?? ''
      return p === 'Anime/Show' ? [dir('Season 1', 'Anime/Show/Season 1')] : []
    }
    return []
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // jsdom matches no media query: the page sees a phone
  const router = createMemoryRouter(
    [
      {
        path: '/rename',
        element: (
          <Shell>
            <Rename />
          </Shell>
        ),
      },
    ],
    { initialEntries: ['/rename?path=Anime%2FShow'] },
  )
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { qc, router }
}

afterEach(() => vi.restoreAllMocks())

describe('Rename page on a phone', () => {
  it('lets the path field be emptied and edited while the picker is open', async () => {
    mount()
    const field = (await screen.findByRole('combobox', { name: 'rename.folder' })) as HTMLInputElement
    expect(field.value).toBe('Anime/Show')
    fireEvent.change(field, { target: { value: '' } })
    expect(field.value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'rename.browse' }))
    fireEvent.change(field, { target: { value: 'Anime/Sho' } })
    expect(field.value).toBe('Anime/Sho')
  })

  it('drops an uncommitted draft when the folder changes, and marks the catalog grid stale after applying', async () => {
    const { qc, router } = mount()
    const field = (await screen.findByRole('combobox', { name: 'rename.folder' })) as HTMLInputElement
    fireEvent.change(field, { target: { value: 'draft' } })
    await router.navigate('/rename?path=Other')
    await waitFor(() => expect(field.value).toBe('Other'))

    vi.spyOn(api, 'post').mockImplementation(async (u: string) => {
      const pair = [{ old: 'a.mkv', new: 'b.mkv', error: '' }]
      if (u === '/api/rename/preview' || u === '/api/rename/apply') return pair as never
      return {} as never
    })
    qc.setQueryData(['catalog', 0, 'Other'], { items: [] })
    const apply = await screen.findByRole('button', { name: 'rename.apply' }, { timeout: 3000 })
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
    fireEvent.click(apply)
    await waitFor(() => expect(qc.getQueryState(['catalog', 0, 'Other'])?.isInvalidated).toBe(true))
  })
})
