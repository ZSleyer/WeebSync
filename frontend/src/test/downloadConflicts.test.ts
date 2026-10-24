import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, keyConflictOf } from '../api'
import i18n from '../locales'

// Queueing, syncing and retrying a download answer 409 in two new cases: the
// server's SSH host key needs a review, or another download for the same file
// is still in the queue. Both arrive as the server's English sentence; the
// person gets it in their language, and the host key body stays readable for
// the review prompt.
function answer(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
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

describe('download conflicts', () => {
  it('says a busy target in words', async () => {
    await i18n.changeLanguage('de')
    answer(409, { error: 'another download for the same file is still in the queue' })
    const e = await failure(api.post('/api/downloads/7/resume'))
    expect(e.status).toBe(409)
    expect(e.message).toBe(i18n.t('errors.targetBusy'))
    expect(e.message).not.toMatch(/another download/)
  })

  it('says an untrusted or changed host key in words and keeps the key for review', async () => {
    await i18n.changeLanguage('en')
    const body = {
      error: 'ssh host key not trusted yet - review its fingerprint and accept it',
      code: 'host_key_unknown',
      newKey: 'AAAA',
      newFingerprint: 'ssh-ed25519 SHA256:x',
    }
    for (const url of ['/api/downloads', '/api/downloads/sync']) {
      answer(409, body)
      const e = await failure(api.post(url, { serverId: 1, remotePath: '/x', localPath: 'x' }))
      expect(e.message).toBe(i18n.t('errors.hostKeyUnknown'))
      expect(keyConflictOf(e)?.newKey).toBe('AAAA')
    }
    answer(409, { ...body, error: 'ssh host key mismatch - server changed or MITM', code: 'host_key_mismatch' })
    expect((await failure(api.post('/api/downloads', {}))).message).toBe(i18n.t('errors.hostKeyChanged'))
  })
})
