import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Download } from '../api'
import AppBadgeSync from '../components/AppBadgeSync'
import { useNeedsData } from '../pages/today/useNeedsData'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

const failed = (id: number): Download =>
  ({
    id,
    userId: 1,
    serverId: 1,
    remotePath: `/a/Show ${id}.mkv`,
    localPath: '/x',
    status: 'error',
    error: 'connection refused',
    finishedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
  }) as unknown as Download

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'setAppBadge')
  Reflect.deleteProperty(navigator, 'clearAppBadge')
  localStorage.clear()
})

const wire = (downloads: Download[]) => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/api/downloads') return downloads as never
    if (path === '/api/downloads/meta') return { items: {}, groups: [] } as never
    if (path === '/api/watches') return [] as never
    if (path === '/api/catalog/scope-hints') return [] as never
    if (path === '/api/servers') return [] as never
    return {} as never
  })
  return get
}

describe('AppBadgeSync', () => {
  it('puts what needs a hand on the app icon, from the shell', async () => {
    const set = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { setAppBadge: set, clearAppBadge: vi.fn().mockResolvedValue(undefined) })
    wire([failed(1), failed(2)])
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <AppBadgeSync />
      </QueryClientProvider>,
    )
    // failures with one cause are one row
    await waitFor(() => expect(set).toHaveBeenCalledWith(1))
  })

  it('shares one request per query with the page that reads the same data', async () => {
    Object.assign(navigator, { setAppBadge: vi.fn().mockResolvedValue(undefined), clearAppBadge: vi.fn() })
    const get = wire([])
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Page() {
      useNeedsData()
      return null
    }
    render(
      <QueryClientProvider client={qc}>
        <AppBadgeSync />
        <Page />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/downloads'))
    const calls = (path: string) => get.mock.calls.filter((c) => c[0] === path).length
    expect(calls('/api/downloads')).toBe(1)
    expect(calls('/api/watches')).toBe(1)
    expect(calls('/api/catalog/scope-hints')).toBe(1)
  })
})
