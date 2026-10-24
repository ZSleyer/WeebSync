import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import Security from '../pages/settings/Security'
import Matching from '../pages/settings/Matching'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))
vi.mock('../hooks/useUnsavedGuard', () => ({ UnsavedGuard: () => null }))

afterEach(() => vi.restoreAllMocks())

function show(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

describe.each([
  ['Security', <Security key="s" />],
  ['Matching', <Matching key="m" />],
])('%s load failure', (_name, page) => {
  it('says what failed and retries on request', async () => {
    const get = vi.spyOn(api, 'get').mockRejectedValue(new Error('boom'))
    show(page)
    expect((await screen.findByRole('alert')).textContent).toContain('settings.loadFailed')
    const calls = get.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'settings.loadRetry' }))
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(calls))
  })
})
