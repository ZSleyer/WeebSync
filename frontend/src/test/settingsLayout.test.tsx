import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  it('swipes to the next section in the menu order', async () => {
    app('/settings/general')
    swipe(-100)
    await waitFor(() => expect(screen.getByRole('link', { name: /settings.nav.account/ })).toHaveAttribute('aria-current', 'page'))
  })

  it('stops at the first section', async () => {
    app('/settings/general')
    swipe(100)
    await waitFor(() => expect(screen.getByRole('link', { name: /settings.nav.general/ })).toHaveAttribute('aria-current', 'page'))
  })

  it('stops at the last section a non-admin has', async () => {
    // without the admin groups the server list is the end of the menu
    app('/settings/servers')
    swipe(-100)
    await waitFor(() => expect(screen.getByRole('link', { name: /nav.servers/ })).toHaveAttribute('aria-current', 'page'))
  })

  it('walks into the admin sections for an admin', async () => {
    app('/settings/servers', true)
    // the admin groups only join the menu once /api/auth/me has answered
    await screen.findByRole('link', { name: /settings.nav.transfers/ })
    swipe(-100)
    await waitFor(() => expect(screen.getByRole('link', { name: /settings.nav.transfers/ })).toHaveAttribute('aria-current', 'page'))
  })
})
