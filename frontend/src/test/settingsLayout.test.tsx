import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SettingsLayout from '../pages/settings/SettingsLayout'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => vi.restoreAllMocks())

const app = (path: string, isAdmin = false) => {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/auth/me') return { email: 'a@b.c', isAdmin }
    return {}
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path=":section" element={<p>Inhalt</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** A swipe across the section area; negative goes forward. */
const swipe = (dx: number) => {
  const zone = screen.getByText('Inhalt').parentElement as HTMLElement
  fireEvent.pointerDown(zone, { clientX: 200, clientY: 100, pointerId: 1, button: 0, pointerType: 'touch' })
  fireEvent.pointerMove(zone, { clientX: 200 + dx / 4, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(zone, { clientX: 200 + dx, clientY: 100, pointerId: 1 })
  fireEvent.pointerUp(zone, { clientX: 200 + dx, clientY: 100, pointerId: 1 })
}

describe('SettingsLayout', () => {
  // the section swipe is gone: it fought the gestures inside the page
  it('stays on its section under a sideways swipe', async () => {
    app('/settings/general')
    swipe(-100)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByRole('link', { name: /settings.nav.general/ })).toHaveAttribute('aria-current', 'page')
  })

  // the search stands in for the menu while it holds text, and finds the
  // panels inside a section, but only those of sections the user can open
  it('finds panels inside the sections it may show', async () => {
    app('/settings/general', true)
    const field = screen.getByRole('searchbox', { name: 'settings.search.label' })
    fireEvent.change(field, { target: { value: 'plex' } })
    expect(await screen.findByRole('link', { name: /settings\.plex/ })).toHaveAttribute(
      'href',
      '/settings/integrations#plex',
    )
    fireEvent.change(field, { target: { value: 'zzz' } })
    expect(screen.getByText('settings.search.none')).toBeInTheDocument()
  })

  it('keeps admin panels out of a user search', async () => {
    app('/settings/general')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'plex' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('link', { name: /settings\.plex/ })).toBeNull()
  })
})
