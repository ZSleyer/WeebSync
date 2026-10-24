import { act, fireEvent, render, screen } from '@testing-library/react'
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

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

const cfg = { authMode: 'password', oidc: false, registrationOpen: false, passwordReset: true }

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Login stage changes keep the focus on the page', () => {
  it('lands on the heading of a security-key-only second factor, and on the email field when going back', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(cfg)
    vi.spyOn(api, 'post').mockResolvedValue({ twoFactorRequired: true, token: 't', totp: false, webauthn: true })
    mount()
    fireEvent.change(await screen.findByLabelText('login.email'), { target: { value: 'a@example.com' } })
    fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'secret secret' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'login.submitLogin' })))
    const h = await screen.findByRole('heading', { name: 'login.totpTitle' })
    expect(document.activeElement).toBe(h)
    fireEvent.click(screen.getByRole('button', { name: 'login.back' }))
    expect(document.activeElement).toBe(screen.getByLabelText('login.email'))
  })

  it('keeps the focus when the forgotten-password link was asked for, and back to the login', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(cfg)
    vi.spyOn(api, 'post').mockResolvedValue({})
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'login.forgotShort' }))
    fireEvent.change(screen.getByLabelText('login.email'), { target: { value: 'a@example.com' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'login.forgotSubmit' })))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'login.sentTitle' }))
    fireEvent.click(screen.getByRole('button', { name: 'login.toLogin' }))
    expect(document.activeElement).toBe(screen.getByLabelText('login.email'))
  })
})

describe('Login address parameters', () => {
  it('says a refused provider sign-in once, not again when the login mounts after a session expiry', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(cfg)
    window.history.replaceState(null, '', '/?oidc_error=denied&loggedout=1')
    const first = mount()
    expect((await screen.findByRole('alert')).textContent).toBe('login.oidcError.denied')
    expect(screen.getByRole('status').textContent).toBe('login.loggedOut')
    expect(window.location.search).toBe('')
    first.unmount()
    // the session ran out in the SPA: the login screen comes back without a reload
    mount()
    await screen.findByLabelText('login.email')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('login.loggedOut')).toBeNull()
  })

  it('opens the reset form with the token of the address, and not again once it is spent', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(cfg)
    const post = vi.spyOn(api, 'post').mockResolvedValue({})
    window.history.replaceState(null, '', '/#reset=tok123')
    const first = mount()
    fireEvent.change(await screen.findByLabelText('account.passwordNew'), { target: { value: 'a long password' } })
    fireEvent.change(screen.getByLabelText('account.passwordAgain'), { target: { value: 'a long password' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'login.resetSubmit' })))
    expect(post).toHaveBeenCalledWith('/api/auth/reset', { token: 'tok123', password: 'a long password' })
    first.unmount()
    mount()
    expect(await screen.findByLabelText('login.email')).toBeTruthy()
  })
})

