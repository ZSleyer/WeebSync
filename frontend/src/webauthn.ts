import { startRegistration, startAuthentication, browserSupportsWebAuthnAutofill } from '@simplewebauthn/browser'
import { api } from './api'
import i18n from './locales'

// The browser's own refusal (the user closed the dialog, the device said no,
// it timed out) arrives as an English DOMException with a link to the spec;
// say it in the UI language instead.
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError'))
      throw new Error(i18n.t('errors.passkeyCancelled'), { cause: e })
    throw e
  }
}

export const supportsPasskeyAutofill = () => browserSupportsWebAuthnAutofill()

// conditionalPasskeyLogin arms the browser's passkey autofill: it resolves only
// when the user actually picks a passkey from the input's autofill dropdown, so
// no explicit button is needed. Aborts silently if the user ignores it.
// remember is read when the passkey is picked, not when the field is armed.
export async function conditionalPasskeyLogin(remember: () => boolean): Promise<void> {
  const begin = await api.post<Begin>('/api/auth/webauthn/login/begin')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asse = await startAuthentication({ optionsJSON: begin.publicKey as any, useBrowserAutofill: true })
  // ceremony id rides in a header, not the query string, so it stays out of logs
  await api.post('/api/auth/webauthn/login/finish', asse, {
    'X-WA-Session': begin.sessionId,
    'X-Remember': remember() ? '1' : '0',
  })
}

type Begin = { sessionId: string; publicKey: unknown }

// registerCredential runs the WebAuthn registration ceremony for the current
// user. kind "passkey" = discoverable/passwordless, "key" = roaming 2nd factor.
// The account's password confirms the change ("" for an OIDC account).
export async function registerCredential(kind: 'passkey' | 'key', name: string, password: string): Promise<void> {
  const begin = await api.post<Begin>('/api/auth/webauthn/register/begin', { password }, { 'X-WA-Type': kind })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const att = await ceremony(() => startRegistration({ optionsJSON: begin.publicKey as any }))
  await api.post('/api/auth/webauthn/register/finish', att, {
    'X-WA-Session': begin.sessionId,
    'X-WA-Type': kind,
    'X-WA-Name': name,
  })
}

// loginPasskey runs a discoverable (usernameless) passwordless login.
export async function loginPasskey(remember: boolean): Promise<void> {
  const begin = await api.post<Begin>('/api/auth/webauthn/login/begin')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asse = await ceremony(() => startAuthentication({ optionsJSON: begin.publicKey as any }))
  await api.post('/api/auth/webauthn/login/finish', asse, {
    'X-WA-Session': begin.sessionId,
    'X-Remember': remember ? '1' : '0',
  })
}

// assertSecurityKey completes a password login's second factor with a key.
export async function assertSecurityKey(token: string): Promise<void> {
  const begin = await api.post<Begin>('/api/auth/webauthn/2fa/begin', { token })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asse = await ceremony(() => startAuthentication({ optionsJSON: begin.publicKey as any }))
  await api.post('/api/auth/webauthn/2fa/finish', asse, {
    'X-WA-Token': token,
    'X-WA-Session': begin.sessionId,
  })
}
