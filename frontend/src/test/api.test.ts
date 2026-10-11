import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'

const stub = (res: Response) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => res),
  )

afterEach(() => vi.unstubAllGlobals())

describe('api request', () => {
  // unlinking a Plex show answers 204; reading that as JSON threw
  // "Unexpected end of JSON input" and the unlink looked failed
  it('treats a 204 as a success without a body', async () => {
    stub(new Response(null, { status: 204 }))
    await expect(api.del('/api/x')).resolves.toBeUndefined()
  })

  it('still parses a JSON body', async () => {
    stub(new Response('{"a":1}', { status: 200 }))
    await expect(api.get('/api/x')).resolves.toEqual({ a: 1 })
  })

  it('names the status when an error has neither body nor reason phrase', async () => {
    stub(new Response('', { status: 502, statusText: '' }))
    await expect(api.get('/api/x')).rejects.toThrow('HTTP 502')
  })
})
