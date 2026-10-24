import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PlexServerSignIn from '../components/PlexServerSignIn'
import JellyfinQuickConnect from '../components/JellyfinQuickConnect'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
  Trans: (({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>) as never,
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(window, 'open').mockReturnValue(null)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  )

describe('PlexServerSignIn', () => {
  const pin = { id: 7, code: 'ABCD', url: 'https://plex.tv/link' }

  it('offers another account when the signed-in one has no server', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(pin)
    vi.spyOn(api, 'get').mockResolvedValue({ linked: true, servers: [] })
    wrap(<PlexServerSignIn connected={false} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.plexSignIn' })))
    await act(async () => vi.advanceTimersByTimeAsync(2100))
    expect(screen.getByText('settings.plexNoServers')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'settings.plexOtherAccount' }))
    expect(screen.getByRole('button', { name: 'settings.plexSignIn' })).toBeTruthy()
  })

  it('links the plex.tv page and can be cancelled while it waits', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(pin)
    const get = vi.spyOn(api, 'get').mockResolvedValue({ linked: false })
    wrap(<PlexServerSignIn connected={false} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.plexSignIn' })))
    // a browser that blocked the popup leaves this link as the way on
    expect(screen.getByRole('link', { name: 'settings.plexOpenTab' }).getAttribute('href')).toBe(pin.url)
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(screen.getByRole('button', { name: 'settings.plexSignIn' })).toBeTruthy()
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(get).not.toHaveBeenCalled()
  })

  it('does not poll when it was unmounted while the sign-in started', async () => {
    let resolve!: (v: unknown) => void
    vi.spyOn(api, 'post').mockReturnValue(new Promise((r) => (resolve = r)))
    const get = vi.spyOn(api, 'get').mockResolvedValue({ linked: false })
    const { unmount } = wrap(<PlexServerSignIn connected={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.plexSignIn' }))
    unmount()
    await act(async () => resolve(pin))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(get).not.toHaveBeenCalled()
  })
})

describe('JellyfinQuickConnect', () => {
  it('does not poll or finish when it was unmounted while the request started', async () => {
    let resolve!: (v: unknown) => void
    vi.spyOn(api, 'post').mockReturnValue(new Promise((r) => (resolve = r)))
    const get = vi.spyOn(api, 'get').mockResolvedValue({ linked: true, user: 'me' })
    const onDone = vi.fn()
    const { unmount } = wrap(<JellyfinQuickConnect server="http://jf" label="go" onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    unmount()
    await act(async () => resolve({ id: 'x', code: '123456' }))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(get).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })
})
