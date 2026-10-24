import { act, render, screen, waitFor } from '@testing-library/react'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
const infoFor = vi.hoisted(() => ({ fail: false }))

vi.mock('hls.js', () => ({ default: class { static isSupported = () => false } }))
vi.mock('jassub', () => ({ default: class {} }))
vi.mock('../pages/jassubWorker?worker&url', () => ({ default: 'worker.js' }))
vi.mock('../components/useImmersive', () => ({ useImmersive: () => {} }))
vi.mock('../components/toast', () => ({ useToast: () => () => {} }))
vi.mock('../api', async (orig) => {
  const real = await orig<typeof import('../api')>()
  return {
    ...real,
    api: {
      ...real.api,
      get: vi.fn(async (url: string) => {
        calls.push(url)
        if (url.startsWith('/api/play/info')) {
          if (infoFor.fail) throw new Error('boom')
          return {
            duration: 1400,
            container: 'mp4',
            video: { codec: 'h264', width: 1920, height: 1080 },
            audio: [{ index: 1, codec: 'aac', lang: 'jpn', default: true }],
            subs: [],
            chapters: [],
          }
        }
        return []
      }),
    },
  }
})

import Player from '../pages/Player'
import { SeriesModalProvider } from '../components/SeriesModal'

function Where() {
  const l = useLocation()
  return <output data-testid="where">{l.search}</output>
}

function mount(client = new QueryClient({ defaultOptions: { queries: { staleTime: 0 } } })) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/play?server=0&path=%2Fa%2Fep1.mp4']}>
        <SeriesModalProvider>
          <Player />
        </SeriesModalProvider>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  calls.length = 0
  infoFor.fail = false
  Object.defineProperty(HTMLMediaElement.prototype, 'load', { value: () => {}, configurable: true })
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: () => Promise.resolve(), configurable: true })
})

describe('Player page', () => {
  it('F01a-1: a window refocus neither refetches play-info nor drops a running player on a failed refetch', async () => {
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('video')).toBeTruthy())
    const infoCalls = () => calls.filter((c) => c.startsWith('/api/play/info')).length
    expect(infoCalls()).toBe(1)
    infoFor.fail = true
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    expect(infoCalls()).toBe(1)
    expect(container.querySelector('video')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
