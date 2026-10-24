import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import Login from '../pages/Login'
import { api, ApiError } from '../api'
import * as webauthn from '../webauthn'

// Login reads this once at load, so it must exist before the import runs
vi.hoisted(() => Object.defineProperty(window, 'PublicKeyCredential', { value: function () {}, configurable: true }))

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }) as never,
}))
vi.mock('../webauthn', () => ({
  loginPasskey: vi.fn(),
  assertSecurityKey: vi.fn(),
  supportsPasskeyAutofill: () => Promise.resolve(true),
  conditionalPasskeyLogin: vi.fn(),
}))

afterEach(() => vi.restoreAllMocks())

function mount() {
  vi.spyOn(api, 'get').mockResolvedValue({ authMode: 'password', oidc: false, registrationOpen: false })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Login passkey autofill', () => {
  it('shows the server refusal of a picked passkey', async () => {
    // the remember flag is read only after the user picked a passkey
    vi.mocked(webauthn.conditionalPasskeyLogin).mockImplementation((remember) => {
      remember()
      return Promise.reject(new ApiError(403, 'awaiting approval'))
    })
    mount()
    expect((await screen.findByRole('alert')).textContent).toBe('awaiting approval')
  })

  it('stays silent when starting the autofill ceremony fails on page load', async () => {
    vi.mocked(webauthn.conditionalPasskeyLogin).mockRejectedValue(new ApiError(429, 'too many'))
    mount()
    await screen.findByLabelText('login.email')
    await waitFor(() => expect(webauthn.conditionalPasskeyLogin).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stays silent when the ceremony is aborted', async () => {
    vi.mocked(webauthn.conditionalPasskeyLogin).mockRejectedValue(new DOMException('x', 'AbortError'))
    mount()
    await screen.findByLabelText('login.email')
    await waitFor(() => expect(webauthn.conditionalPasskeyLogin).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('arms the autofill again after the passkey button was cancelled', async () => {
    vi.mocked(webauthn.conditionalPasskeyLogin).mockReturnValue(new Promise(() => {}))
    vi.mocked(webauthn.loginPasskey).mockRejectedValue(new Error('cancelled'))
    mount()
    await waitFor(() => expect(webauthn.conditionalPasskeyLogin).toHaveBeenCalledTimes(1))
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'login.passkey' })))
    await waitFor(() => expect(webauthn.conditionalPasskeyLogin).toHaveBeenCalledTimes(2))
  })
})
