import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { AdminGate } from '../App'
import { api } from '../api'

const media = { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AdminGate with blocked storage', () => {
  it('renders the shell instead of crashing when sessionStorage throws', async () => {
    vi.stubGlobal('matchMedia', () => media)
    vi.spyOn(api, 'get').mockResolvedValue({ onboardingDone: true })
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    const router = createMemoryRouter(
      [{ path: '*', element: <AdminGate email="a@b.c" />, errorElement: <p>route error</p> }],
      { initialEntries: ['/'] },
    )
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(read).toHaveBeenCalled())
    expect(screen.queryByText('route error')).toBeNull()
    expect(document.querySelector('.app-shell')).not.toBeNull()
  })
})
