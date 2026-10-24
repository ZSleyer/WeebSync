import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: {
    post: vi.fn(async (path: string) => {
      calls.push(`post ${path}`)
    }),
  },
}))
const unsubscribe = vi.fn()
vi.mock('../push', () => ({
  unsubscribePush: () => unsubscribe(),
}))

import { logout } from '../hooks'

describe('logout', () => {
  beforeEach(() => {
    calls.length = 0
    unsubscribe.mockReset()
    unsubscribe.mockImplementation(async () => {
      calls.push('unsubscribe')
    })
    localStorage.clear()
    sessionStorage.clear()
    Object.defineProperty(window, 'location', { value: { href: '/' }, writable: true })
  })

  it('drops the push subscription while the session is still valid, then the previous account data', async () => {
    localStorage.setItem('weebsync.cache.7.watches', '[1]')
    localStorage.setItem('weebsync.ai.model.7', 'm')
    localStorage.setItem('weebsync.ai.tools.7', '{}')
    localStorage.setItem('weebsync.search.recent', '["secret"]')
    localStorage.setItem('weebsync.files.bookmarks', '[{"source":1,"path":"a"}]')
    localStorage.setItem('viewer.pos:1:/a.mp3', '12')
    localStorage.setItem('viewer.done:1:/a.mkv', '1')
    localStorage.setItem('weebsync.player.pos', '{}')
    localStorage.setItem('weebsync.palette.recent', '[]')
    localStorage.setItem('weebsync.theme', 'dark')
    localStorage.setItem('weebsync.scheme', 'x')
    sessionStorage.setItem('weebsync.ai.chat.7', '3')
    sessionStorage.setItem('weebsync.ai.7', '[{"q":"private"}]')

    await logout()

    expect(calls).toEqual(['unsubscribe', 'post /api/auth/logout'])
    expect(Object.keys(localStorage).sort()).toEqual(['weebsync.scheme', 'weebsync.theme'])
    expect(sessionStorage.length).toBe(0)
    expect(window.location.href).toBe('/?loggedout=1')
  })

  it('still signs out and clears when the push cleanup fails or hangs', async () => {
    unsubscribe.mockRejectedValue(new Error('no service worker'))
    localStorage.setItem('weebsync.cache.7.watches', '[1]')
    await logout()
    expect(calls).toEqual(['post /api/auth/logout'])
    expect(localStorage.length).toBe(0)

  })

  it('sends the logout POST at once even when the push cleanup never settles', async () => {
    unsubscribe.mockReturnValue(new Promise(() => {}))
    localStorage.setItem('weebsync.cache.7.watches', '[1]')
    vi.useFakeTimers()
    try {
      // no timer is advanced: the sign-out must not wait for the cleanup
      await logout()
    } finally {
      vi.useRealTimers()
    }
    expect(calls).toEqual(['post /api/auth/logout'])
    expect(localStorage.length).toBe(0)
    expect(window.location.href).toBe('/?loggedout=1')
  })
})
