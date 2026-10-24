import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import HwAccelPanel from '../pages/settings/HwAccel'
import { api } from '../api'
import { copyText } from '../clipboard'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))
vi.mock('../clipboard', () => ({ copyText: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

const report = {
  mode: 'auto',
  probing: false,
  issues: [],
  choice: { encoder: 'software', maxHeight: 1080 },
  candidates: [{ encoder: 'nvenc', code: 'no_nvidia_device', params: {} }],
}

function setup() {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => (url === '/api/admin/hwaccel' ? report : {}) as never)
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HwAccelPanel />
    </QueryClientProvider>,
  )
}

describe('the compose fix copy button', () => {
  it('says so when the clipboard refuses', async () => {
    vi.mocked(copyText).mockResolvedValue(false)
    setup()
    fireEvent.click(await screen.findByRole('button', { name: 'settings.hw.copy' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.hw.copyFailed')
    expect(screen.queryByText('settings.hw.copied')).toBeNull()
  })

  it('confirms a successful copy without an error', async () => {
    vi.mocked(copyText).mockResolvedValue(true)
    setup()
    fireEvent.click(await screen.findByRole('button', { name: 'settings.hw.copy' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.hw.copied' })).toBeInTheDocument())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
