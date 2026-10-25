import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import i18n from '../locales'

// The server refuses a device code in English; the person reads it in their
// language.
afterEach(async () => {
  vi.unstubAllGlobals()
  await i18n.changeLanguage('en')
})

describe('device code errors', () => {
  it('says an unknown or expired code in German', async () => {
    await i18n.changeLanguage('de')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'unknown or expired code' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )
    const err = await api.post('/api/devices/approve', { userCode: 'BBBB-BBBB' }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(i18n.t('errors.deviceCodeUnknown'))
    expect((err as Error).message).toMatch(/Code/)
    expect((err as Error).message).not.toMatch(/unknown or expired/)
  })
})
