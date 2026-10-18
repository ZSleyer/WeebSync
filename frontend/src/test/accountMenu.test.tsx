import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  it('unfolds the entries from the address button', () => {
    app(<AccountMenu email="a@b.c" />)
    const button = screen.getByRole('button', { name: 'a@b.c' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('group', { hidden: true })).toHaveAttribute('inert')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    const group = screen.getByRole('group', { name: 'nav.accountMenu' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((i) => i.textContent),
    ).toEqual([
      'nav.settings',
      'settings.nav.account',
      'nav.appearance',
      'settings.nav.rules',
      'settings.nav.about',
      'app.logout',
    ])
    expect(within(group).getByRole('separator')).toBeInTheDocument()
  })

  it('goes to the chosen place and folds', () => {
    app(<AccountMenu email="a@b.c" />)
    const button = screen.getByRole('button', { name: 'a@b.c' })
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: 'settings.nav.rules' }))
    expect(screen.getByLabelText('where')).toHaveTextContent('/rules')
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('folds on Escape and gives focus back to the button', () => {
    app(<AccountMenu email="a@b.c" />)
    const button = screen.getByRole('button', { name: 'a@b.c' })
    fireEvent.click(button)
    fireEvent.keyDown(screen.getByRole('button', { name: 'nav.settings' }), { key: 'Escape' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()
  })

  it('folds on a press outside', () => {
    app(<AccountMenu email="a@b.c" />)
    const button = screen.getByRole('button', { name: 'a@b.c' })
    fireEvent.click(button)
    fireEvent.pointerDown(document.body)
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('marks the button and the About entry while an update is out', async () => {
    app(<AccountMenu email="a@b.c" />, true)
    const button = await screen.findByRole('button', { name: /a@b.c.*app.updateHint|app.updateHint.*a@b.c/ })
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: /settings.nav.about/ })).toHaveTextContent('app.updateHint')
    expect(screen.getByRole('button', { name: /nav.settings$/ })).not.toHaveTextContent('app.updateHint')
  })
})

describe('AccountSheetButton', () => {
  it('opens the same entries as a sheet headed by the address', async () => {
    app(<AccountSheetButton email="a@b.c" />)
    fireEvent.click(screen.getByRole('button', { name: /^nav\.accountMenu/ }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByRole('heading', { name: 'a@b.c' })).toBeInTheDocument()
    expect(within(sheet).getAllByRole('button')).toHaveLength(6)
    fireEvent.click(within(sheet).getByRole('button', { name: 'settings.nav.account' }))
    // the action runs once the sheet's own history step has landed
    await waitFor(() => expect(screen.getByLabelText('where')).toHaveTextContent('/settings/account'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
