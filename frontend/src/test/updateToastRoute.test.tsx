import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import UpdateToast from '../components/UpdateToast'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: { s?: number }) => (o?.s === undefined ? k : `${k}:${o.s}`) }) as never,
}))

const reload = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('location', { ...window.location, reload })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html><head><script type="module" src="/assets/new.js"></script></head></html>')),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  reload.mockClear()
})

// the toast is armed by the 5 minute poll, then counts down 60 s
async function armed(handle: object) {
  const router = createMemoryRouter([{ path: '/', element: <UpdateToast />, handle }], { initialEntries: ['/'] })
  render(<RouterProvider router={router} />)
  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000 + 10))
  expect(screen.getByText('app.updateAvailable')).toBeInTheDocument()
}

describe('UpdateToast countdown by route', () => {
  it('reloads by itself on an ordinary page', async () => {
    await armed({})
    await act(() => vi.advanceTimersByTimeAsync(65_000))
    expect(reload).toHaveBeenCalled()
  })

  it('never reloads by itself on a full-screen route (player, viewer), wide or not', async () => {
    await armed({ immersive: true })
    await act(() => vi.advanceTimersByTimeAsync(180_000))
    expect(reload).not.toHaveBeenCalled()
    // no countdown that never runs out
    expect(screen.queryByText(/app\.reloadIn/)).toBeNull()
    expect(screen.getByText('app.reloadWhenReady')).toBeInTheDocument()
    expect(screen.getByText('app.reloadNow')).toBeInTheDocument()
  })
})
