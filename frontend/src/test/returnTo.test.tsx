import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { rememberReturn, takeReturn, useRestoreReturn } from '../returnTo'
import { parseShare } from '../share'

const KEY = 'weebsync.returnTo'
const at = (url: string) => history.replaceState(null, '', url)

beforeEach(() => sessionStorage.clear())
afterEach(() => {
  vi.useRealTimers()
  at('/')
})

describe('the shared payload and the sign-in round trip', () => {
  it('remembers a share and hands it back once', () => {
    at('/share?title=Frieren&url=https%3A%2F%2Fanilist.co%2Fanime%2F154587')
    rememberReturn()
    expect(takeReturn()).toBe('/share?title=Frieren&url=https%3A%2F%2Fanilist.co%2Fanime%2F154587')
    expect(takeReturn()).toBeNull()
  })

  it('keeps nothing for the start page, the api or a foreign address', () => {
    at('/')
    rememberReturn()
    expect(sessionStorage.getItem(KEY)).toBeNull()
    at('/api/auth/oidc/login')
    rememberReturn()
    expect(sessionStorage.getItem(KEY)).toBeNull()
    sessionStorage.setItem(KEY, JSON.stringify({ to: '//evil.example/x', at: Date.now() }))
    expect(takeReturn()).toBeNull()
    sessionStorage.setItem(KEY, JSON.stringify({ to: 'https://evil.example/x', at: Date.now() }))
    expect(takeReturn()).toBeNull()
  })

  it('lets a stale note go', () => {
    vi.useFakeTimers()
    at('/share?text=x')
    rememberReturn()
    vi.advanceTimersByTime(16 * 60_000)
    expect(takeReturn()).toBeNull()
  })

  it('lands on /share after the provider sent the visitor to the start page', async () => {
    at('/share?title=Frieren&text=great')
    rememberReturn()
    // the round trip ends on "/"
    at('/')
    function Spy() {
      useRestoreReturn(true)
      return null
    }
    const router = createMemoryRouter([{ path: '*', element: <Spy /> }], { initialEntries: ['/'] })
    render(<RouterProvider router={router} />)
    const here = () => router.state.location.pathname + router.state.location.search
    await vi.waitFor(() => expect(here()).toBe('/share?title=Frieren&text=great'))
    const path = here()
    // and the payload still reads as what was shared
    expect(parseShare(new URLSearchParams(path.split('?')[1]))).toEqual({ kind: 'search', q: 'Frieren great' })
  })

  it('does not act before the sign-in is through', () => {
    at('/share?text=x')
    rememberReturn()
    at('/')
    function Spy() {
      useRestoreReturn(false)
      return null
    }
    render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <Spy /> }])} />)
    expect(sessionStorage.getItem(KEY)).not.toBeNull()
  })
})
