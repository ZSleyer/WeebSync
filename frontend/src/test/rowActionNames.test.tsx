import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfirmProvider } from '../components/confirm'
import Users from '../pages/settings/Users'
import { RateLimitSection } from '../pages/settings/Security'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => vi.restoreAllMocks())

const account = (id: number, email: string, over = {}) => ({
  id,
  email,
  isAdmin: false,
  emailVerified: true,
  approved: true,
  ...over,
})

function show(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{ui}</ConfirmProvider>
    </QueryClientProvider>,
  )
}

describe('row actions name their row', () => {
  it('Users: every action carries the account', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url === '/api/settings') return { authMode: 'password', oidcAdminValues: '', oidcProviderName: '' }
      if (url === '/api/users')
        return [account(1, 'me@x.de', { isAdmin: true }), account(2, 'bob@x.de', { approved: false })]
      return { id: 1 }
    })
    show(<Users />)
    await screen.findByText('bob@x.de')
    for (const label of [
      'settings.usersApprove',
      'settings.usersMakeAdmin',
      'settings.usersSetPassword',
      'servers.delete',
    ])
      expect(await screen.findByRole('button', { name: `${label}: bob@x.de` })).toBeTruthy()
    // no bare, ambiguous "Delete"
    expect(screen.queryByRole('button', { name: 'servers.delete' })).toBeNull()
  })

  it('Rate limit: unblock names the address', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([{ ip: '10.0.0.9', kind: 'ip', blocked: true, tokens: 0 }])
    show(<RateLimitSection />)
    expect(await screen.findByRole('button', { name: 'settings.rateLimitUnblock: 10.0.0.9' })).toBeTruthy()
  })
})
