import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { conditionalPasskeyLogin, loginPasskey, registerCredential, supportsPasskeyAutofill } from '../webauthn'

// jsdom has no WebAuthn: stand in for the browser's PublicKeyCredential and
// navigator.credentials, recording what the module hands them.
const parsed = { parsed: true }
const credJSON = { id: 'cred-1', type: 'public-key', response: { clientDataJSON: 'x' } }
let conditional = true

beforeEach(() => {
  vi.stubGlobal('PublicKeyCredential', {
    parseCreationOptionsFromJSON: vi.fn(() => parsed),
    parseRequestOptionsFromJSON: vi.fn(() => parsed),
    isConditionalMediationAvailable: vi.fn(async () => conditional),
  })
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      create: vi.fn(async () => ({ toJSON: () => credJSON })),
      // a get() stays open until its signal aborts, like a passkey prompt
      get: vi.fn(
        (opts: CredentialRequestOptions) =>
          new Promise((resolve, reject) => {
            if (opts.mediation !== 'conditional') return resolve({ toJSON: () => credJSON })
            opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason))
          }),
      ),
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('webauthn on the native JSON API', () => {
  it('parses the server options and posts the credential JSON back', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockImplementation(async (url: string) =>
        url.endsWith('/begin') ? { sessionId: 's1', publicKey: { challenge: 'abc' } } : {},
      )
    await registerCredential('passkey', 'Phone', 'pw')
    expect(PublicKeyCredential.parseCreationOptionsFromJSON).toHaveBeenCalledWith({ challenge: 'abc' })
    expect(navigator.credentials.create).toHaveBeenCalledWith(expect.objectContaining({ publicKey: parsed }))
    expect(post).toHaveBeenLastCalledWith('/api/auth/webauthn/register/finish', credJSON, {
      'X-WA-Session': 's1',
      'X-WA-Type': 'passkey',
      'X-WA-Name': 'Phone',
    })
  })

  it('cancels the armed autofill when a button starts a login', async () => {
    vi.spyOn(api, 'post').mockImplementation(async (url: string) =>
      url.endsWith('/begin') ? { sessionId: 's', publicKey: {} } : {},
    )
    const armed = conditionalPasskeyLogin(() => false)
    await vi.waitFor(() => expect(navigator.credentials.get).toHaveBeenCalledTimes(1))
    await loginPasskey(true)
    await expect(armed).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reports autofill only with conditional mediation', async () => {
    expect(await supportsPasskeyAutofill()).toBe(true)
    conditional = false
    expect(await supportsPasskeyAutofill()).toBe(false)
    conditional = true
  })
})
