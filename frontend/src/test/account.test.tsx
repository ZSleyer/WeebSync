import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Account from '../pages/settings/Account'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, string>) => (o ? `${k} ${Object.values(o).join(' ')}` : k),
      i18n: { language: 'en' },
    }) as never,
}))

afterEach(() => vi.restoreAllMocks())

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0'

function setup() {
  let totpOn = false
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/auth/config') return { authMode: 'password' } as never
    if (url === '/api/auth/me') return { email: 'a@b.c', hasPassword: true } as never
    if (url === '/api/auth/totp') return { enabled: totpOn } as never
    if (url === '/api/auth/webauthn/credentials')
      return [
        { id: 1, name: 'Laptop', passwordless: true },
        { id: 2, name: 'YubiKey', passwordless: false },
      ] as never
    if (url === '/api/auth/sessions')
      return [
        { id: 'a', current: true, userAgent: FIREFOX, ip: '10.0.0.2', createdAt: '2026-01-02T10:00:00Z' },
        { id: 'b', current: false, userAgent: FIREFOX, ip: '8.8.8.8', createdAt: '2026-01-03T10:00:00Z' },
        { id: 'c', current: false, userAgent: FIREFOX, ip: '9.9.9.9', createdAt: '2026-01-04T10:00:00Z' },
      ] as never
    return {} as never
  })
  vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
    if (url === '/api/auth/totp/setup') return { secret: 'SECRET', otpauthUrl: 'otpauth://totp/x?secret=SECRET' } as never
    totpOn = true
    return { recoveryCodes: ['aaaa-1111', 'bbbb-2222'] } as never
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <Account />
    </QueryClientProvider>,
  )
  return within(screen.getByRole('region', { name: 'account.totpTitle' }))
}

describe('TOTP set-up moves focus along', () => {
  it('puts focus on the code field once the secret is shown', async () => {
    const totp = setup()
    fireEvent.change(await totp.findByLabelText('login.password'), { target: { value: 'pw' } })
    fireEvent.click(totp.getByRole('button', { name: 'account.totpEnable' }))
    const code = await totp.findByLabelText('account.totpEnterCode')
    await waitFor(() => expect(code).toHaveFocus())
  })

  it('announces the recovery codes and returns focus when they are closed', async () => {
    const totp = setup()
    fireEvent.change(await totp.findByLabelText('login.password'), { target: { value: 'pw' } })
    fireEvent.click(totp.getByRole('button', { name: 'account.totpEnable' }))
    fireEvent.change(await totp.findByLabelText('account.totpEnterCode'), { target: { value: '123456' } })
    fireEvent.click(totp.getByRole('button', { name: 'account.totpConfirm' }))
    const codes = await screen.findByRole('region', { name: 'account.recoveryTitle' })
    expect(within(codes).getByText('aaaa-1111')).toBeInTheDocument()
    await waitFor(() => expect(within(codes).getByText('account.recoveryTitle')).toHaveFocus())
    fireEvent.click(within(codes).getByRole('button', { name: 'remote.close' }))
    // the focused button is gone; focus lands on a field of the section, not on <body>
    await waitFor(() => expect(document.body).not.toHaveFocus())
    expect(totp.getByLabelText('login.password')).toHaveFocus()
  })

  it('returns focus to the password field when the set-up is cancelled', async () => {
    const totp = setup()
    fireEvent.change(await totp.findByLabelText('login.password'), { target: { value: 'pw' } })
    fireEvent.click(totp.getByRole('button', { name: 'account.totpEnable' }))
    await totp.findByLabelText('account.totpEnterCode')
    fireEvent.click(totp.getByRole('button', { name: 'common.cancel' }))
    await waitFor(() => expect(totp.getByLabelText('login.password')).toHaveFocus())
  })
})

describe('row actions name their row', () => {
  it('passkey removal names the passkey', async () => {
    setup()
    expect(await screen.findByRole('button', { name: 'account.remove: Laptop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'account.remove: YubiKey' })).toBeInTheDocument()
  })

  it('ending a session names the session', async () => {
    setup()
    const ends = await screen.findAllByRole('button', { name: /^account.sessionsEnd:/ })
    expect(ends).toHaveLength(2)
    const names = ends.map((b) => b.getAttribute('aria-label'))
    expect(new Set(names).size).toBe(2)
    expect(names[0]).toContain('Firefox')
    expect(names[0]).toContain('8.8.8.8')
    expect(names[1]).toContain('9.9.9.9')
  })
})
