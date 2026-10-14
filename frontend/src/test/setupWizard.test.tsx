import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Setup from '../pages/Setup'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

const renderSetup = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Setup />
    </QueryClientProvider>,
  )

describe('Setup wizard', () => {
  it('has one h1, the step as h2 and the optional steps marked in the rail', () => {
    vi.spyOn(api, 'get').mockResolvedValue({})
    renderSetup()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('setup.accountTitle')
    expect(screen.getAllByText('setup.optional')).toHaveLength(2)
  })

  it('drops the local account fields for SSO only, and goes on without registering', () => {
    vi.spyOn(api, 'get').mockResolvedValue({})
    const post = vi.spyOn(api, 'post')
    renderSetup()
    expect(screen.getByLabelText('login.email')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.queryByLabelText('login.email')).toBeNull()
    // the code from the server log is asked for on either path
    fireEvent.change(screen.getByLabelText('setup.token'), { target: { value: 'abcd-efgh' } })
    fireEvent.click(screen.getByRole('button', { name: 'setup.continue' }))
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('setup.oidcTitle')
    // back from the required provider step returns to the account
    fireEvent.click(screen.getByRole('button', { name: 'setup.back' }))
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('setup.accountTitle')
  })
})
