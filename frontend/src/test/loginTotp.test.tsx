import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import Login from '../pages/Login'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }) as never,
}))
vi.mock('../webauthn', () => ({
  loginPasskey: vi.fn(),
  assertSecurityKey: vi.fn(),
  supportsPasskeyAutofill: () => Promise.resolve(false),
  conditionalPasskeyLogin: vi.fn(),
}))

afterEach(() => vi.restoreAllMocks())

describe('Login second factor', () => {
  it('takes digits only and sends the code itself at the sixth', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ authMode: 'password', oidc: false, registrationOpen: false })
    const post = vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
      if (url === '/api/auth/login') return { twoFactorRequired: true, token: 't', totp: true }
      return {}
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Login />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.change(await screen.findByLabelText('login.email'), { target: { value: 'a@example.com' } })
    fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'secret secret' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'login.submitLogin' })))
    const code = await screen.findByLabelText('login.totpCode')
    fireEvent.change(code, { target: { value: '12a34' } })
    expect((code as HTMLInputElement).value).toBe('1234')
    expect(post).not.toHaveBeenCalledWith('/api/auth/login/totp', expect.anything())
    await act(async () => fireEvent.change(code, { target: { value: '123456' } }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/auth/login/totp', { token: 't', code: '123456' }))
  })
})
