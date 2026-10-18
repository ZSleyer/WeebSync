import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AccountMenu, AccountSheetButton } from '../components/AccountMenu'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => vi.restoreAllMocks())

function Where() {
  return <output aria-label="where">{useLocation().pathname}</output>
}

const app = (ui: React.ReactElement, updateAvailable = false) => {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/auth/me') return { email: 'a@b.c', isAdmin: true }
    if (url === '/api/version') return { updateAvailable }
    return {}
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={createMemoryRouter(
          [
            {
              path: '*',
              element: (
                <>
                  {ui}
                  <Where />
                </>
              ),
            },
          ],
          { initialEntries: ['/'] },
        )}
      />
    </QueryClientProvider>,
  )
}

describe('AccountMenu', () => {
  it('opens a menu with the address, the entries and the way out', () => {
    app(<AccountMenu email="a@b.c" />)
    const button = screen.getByRole('button', { name: 'a@b.c' })
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: 'nav.accountMenu' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual([
      'nav.settings',
      'settings.nav.account',
      'nav.appearance',
      'settings.nav.rules',
      'settings.nav.about',
      'app.logout',
    ])
    expect(within(menu).getByRole('separator')).toBeInTheDocument()
  })

  it('goes to the chosen place and closes', () => {
    app(<AccountMenu email="a@b.c" />)
    fireEvent.click(screen.getByRole('button', { name: 'a@b.c' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'settings.nav.rules' }))
    expect(screen.getByLabelText('where')).toHaveTextContent('/rules')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes on Escape', () => {
    app(<AccountMenu email="a@b.c" />)
    fireEvent.click(screen.getByRole('button', { name: 'a@b.c' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('marks the button and the About entry while an update is out', async () => {
    app(<AccountMenu email="a@b.c" />, true)
    const button = await screen.findByRole('button', { name: /app.updateHint/ })
    fireEvent.click(button)
    expect(screen.getByRole('menuitem', { name: /settings.nav.about/ })).toHaveTextContent('app.updateHint')
    expect(screen.getByRole('menuitem', { name: /nav.settings$/ })).not.toHaveTextContent('app.updateHint')
  })
})

describe('AccountSheetButton', () => {
  it('opens the same entries as a sheet headed by the address', () => {
    app(<AccountSheetButton email="a@b.c" />)
    fireEvent.click(screen.getByRole('button', { name: 'nav.settings' }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByRole('heading', { name: 'a@b.c' })).toBeInTheDocument()
    expect(within(sheet).getAllByRole('button')).toHaveLength(6)
    fireEvent.click(within(sheet).getByRole('button', { name: 'settings.nav.account' }))
    expect(screen.getByLabelText('where')).toHaveTextContent('/settings/account')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
