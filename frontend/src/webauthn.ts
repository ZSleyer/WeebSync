// Passkeys and security keys through the browser's own WebAuthn JSON API:
// PublicKeyCredential.parse*OptionsFromJSON reads the server's options, and
// the credential's toJSON() is what the server reads back.
import { api } from './api'
import i18n from './locales'

// One ceremony at a time: the passkey autofill keeps a get() pending, and a
// login started from a button must cancel it, or the browser refuses the
// second request.
let pending: AbortController | undefined
function nextSignal(): AbortSignal {
  pending?.abort(new DOMException('replaced by a new ceremony', 'AbortError'))
  pending = new AbortController()
  return pending.signal
}

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

async function create(options: unknown): Promise<unknown> {
  const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options as PublicKeyCredentialCreationOptionsJSON)
  const cred = (await navigator.credentials.create({ publicKey, signal: nextSignal() })) as PublicKeyCredential
  return cred.toJSON()
}

async function get(options: unknown, mediation?: CredentialMediationRequirement): Promise<unknown> {
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options as PublicKeyCredentialRequestOptionsJSON)
  const cred = (await navigator.credentials.get({ publicKey, mediation, signal: nextSignal() })) as PublicKeyCredential
  return cred.toJSON()
}

// Passkey autofill needs conditional mediation; Firefox on Android, for one,
// has the JSON API but not this.
export const supportsPasskeyAutofill = async (): Promise<boolean> =>
  typeof PublicKeyCredential !== 'undefined' && !!(await PublicKeyCredential.isConditionalMediationAvailable?.())

type Begin = { sessionId: string; publicKey: unknown }

// conditionalPasskeyLogin arms the browser's passkey autofill: it resolves only
// when the user actually picks a passkey from the input's autofill dropdown, so
// no explicit button is needed. Aborts silently if the user ignores it.
// remember is read when the passkey is picked, not when the field is armed.
export async function conditionalPasskeyLogin(remember: () => boolean): Promise<void> {
  const begin = await api.post<Begin>('/api/auth/webauthn/login/begin')
  const asse = await get(begin.publicKey, 'conditional')
  // ceremony id rides in a header, not the query string, so it stays out of logs
  await api.post('/api/auth/webauthn/login/finish', asse, {
    'X-WA-Session': begin.sessionId,
    'X-Remember': remember() ? '1' : '0',
  })
}

// registerCredential runs the WebAuthn registration ceremony for the current
// user. kind "passkey" = discoverable/passwordless, "key" = roaming 2nd factor.
// The account's password confirms the change ("" for an OIDC account).
export async function registerCredential(kind: 'passkey' | 'key', name: string, password: string): Promise<void> {
  const begin = await api.post<Begin>('/api/auth/webauthn/register/begin', { password }, { 'X-WA-Type': kind })
  const att = await ceremony(() => create(begin.publicKey))
  await api.post('/api/auth/webauthn/register/finish', att, {
    'X-WA-Session': begin.sessionId,
    'X-WA-Type': kind,
    'X-WA-Name': name,
  })
}

// loginPasskey runs a discoverable (usernameless) passwordless login.
export async function loginPasskey(remember: boolean): Promise<void> {
  const begin = await api.post<Begin>('/api/auth/webauthn/login/begin')
  const asse = await ceremony(() => get(begin.publicKey))
  await api.post('/api/auth/webauthn/login/finish', asse, {
    'X-WA-Session': begin.sessionId,
    'X-Remember': remember ? '1' : '0',
  })
}

// assertSecurityKey completes a password login's second factor with a key.
export async function assertSecurityKey(token: string): Promise<void> {
  const begin = await api.post<Begin>('/api/auth/webauthn/2fa/begin', { token })
  const asse = await ceremony(() => get(begin.publicKey))
  await api.post('/api/auth/webauthn/2fa/finish', asse, {
    'X-WA-Token': token,
    'X-WA-Session': begin.sessionId,
  })
}
