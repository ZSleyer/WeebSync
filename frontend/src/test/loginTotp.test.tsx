import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import Login, { refusedText } from '../pages/Login'
import { api, ApiError } from '../api'

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

describe('Login refused', () => {
  it('says how many attempts are left from the 401', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ authMode: 'password', oidc: false, registrationOpen: false })
    vi.spyOn(api, 'post').mockRejectedValue(
      new ApiError(401, 'wrong', { error: 'invalid credentials', attemptsLeft: 3, pauseSeconds: 12 }),
    )
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
    expect((await screen.findByRole('alert')).textContent).toBe('wrong login.attemptsLeft')
  })

  it('reads the count and the pause, and nothing without a count', () => {
    const t = (k: string, o?: Record<string, unknown>) => `${k}:${JSON.stringify(o)}`
    expect(refusedText(new ApiError(401, 'no', { attemptsLeft: 2, pauseSeconds: 12 }), t)).toBe(
      'no login.attemptsLeft:{"count":2,"s":12}',
    )
    expect(refusedText(new ApiError(401, 'no', { attemptsLeft: 0, pauseSeconds: 12 }), t)).toBe(
      'no login.attemptsNone:{"s":12}',
    )
    expect(refusedText(new ApiError(401, 'no', { error: 'x' }), t)).toBeNull()
    expect(refusedText(new ApiError(403, 'no', { attemptsLeft: 2 }), t)).toBeNull()
  })
})
