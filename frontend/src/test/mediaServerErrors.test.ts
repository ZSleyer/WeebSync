import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '../api'
import i18n from '../locales'

// The Plex watchlist answers 403 when plex.tv no longer accepts the linked
// account; signing in to Plex or Jellyfin answers 409 when the environment
// already fixes that connection. The person reads both in their language.
function answer(status: number, error: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } }),
    ),
  )
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('request did not fail')
}

afterEach(() => vi.unstubAllGlobals())

const cases: [string, number, string, string, string][] = [
  ['/api/plex/watchlist', 403, 'plex.tv link expired, link the account again', 'errors.plexLinkExpired', 'Plex'],
  [
    '/api/plex/server/pin',
    409,
    'the Plex connection is set by PLEX_URL/PLEX_TOKEN in the environment',
    'errors.plexEnvSet',
    'PLEX_URL',
  ],
  [
    '/api/jellyfin/server/quickconnect',
    409,
    'the Jellyfin connection is set by JELLYFIN_URL/JELLYFIN_TOKEN in the environment',
    'errors.jellyfinEnvSet',
    'JELLYFIN_URL',
  ],
]

describe('media server errors in words', () => {
  for (const lang of ['de', 'en']) {
    for (const [url, status, raw, key, mention] of cases) {
      it(`${key} (${lang})`, async () => {
        await i18n.changeLanguage(lang)
        answer(status, raw)
        const e = await failure(api.get(url))
        expect(e.status).toBe(status)
        expect(e.message).toBe(i18n.t(key))
        expect(e.message).not.toBe(key)
        expect(e.message).not.toBe(raw)
        expect(e.message).toContain(mention)
        expect(e.raw).toBe(raw)
      })
    }
  }
})
