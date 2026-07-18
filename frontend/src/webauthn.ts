import { startRegistration, startAuthentication, browserSupportsWebAuthnAutofill } from '@simplewebauthn/browser'
import { api } from './api'

export const supportsPasskeyAutofill = () => browserSupportsWebAuthnAutofill()

// conditionalPasskeyLogin arms the browser's passkey autofill: it resolves only
// when the user actually picks a passkey from the input's autofill dropdown, so
// no explicit button is needed. Aborts silently if the user ignores it.
export async function conditionalPasskeyLogin(): Promise<void> {
  const begin = await api.post<Begin>('/api/auth/webauthn/login/begin')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asse = await startAuthentication({ optionsJSON: begin.publicKey as any, useBrowserAutofill: true })
  await api.post(`/api/auth/webauthn/login/finish?s=${encodeURIComponent(begin.sessionId)}`, asse)
}

type Begin = { sessionId: string; publicKey: unknown }

// registerCredential runs the WebAuthn registration ceremony for the current
// user. kind "passkey" = discoverable/passwordless, "key" = roaming 2nd factor.
export async function registerCredential(kind: 'passkey' | 'key', name: string): Promise<void> {
  const begin = await api.post<Begin>(`/api/auth/webauthn/register/begin?type=${kind}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const att = await startRegistration({ optionsJSON: (begin.publicKey as any) })
  await api.post(
    `/api/auth/webauthn/register/finish?s=${encodeURIComponent(begin.sessionId)}&type=${kind}&name=${encodeURIComponent(name)}`,
    att,
  )
}

// loginPasskey runs a discoverable (usernameless) passwordless login.
export async function loginPasskey(): Promise<void> {
  const begin = await api.post<Begin>('/api/auth/webauthn/login/begin')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asse = await startAuthentication({ optionsJSON: (begin.publicKey as any) })
  await api.post(`/api/auth/webauthn/login/finish?s=${encodeURIComponent(begin.sessionId)}`, asse)
}

// assertSecurityKey completes a password login's second factor with a key.
export async function assertSecurityKey(token: string): Promise<void> {
  const begin = await api.post<Begin>('/api/auth/webauthn/2fa/begin', { token })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asse = await startAuthentication({ optionsJSON: (begin.publicKey as any) })
  await api.post(
    `/api/auth/webauthn/2fa/finish?token=${encodeURIComponent(token)}&s=${encodeURIComponent(begin.sessionId)}`,
    asse,
  )
}
