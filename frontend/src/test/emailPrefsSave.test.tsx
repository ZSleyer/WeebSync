import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Notifications from '../pages/settings/Notifications'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: Record<string, string>) => (o ? `${k} ${o.cat}` : k) }) as never,
}))

afterEach(() => vi.restoreAllMocks())

describe('e-mail categories', () => {
  it('a second toggle builds on the first while the refetch is still on its way', async () => {
    let mailGets = 0
    vi.spyOn(api, 'get').mockImplementation((url: string) => {
      if (url === '/api/auth/email-prefs') {
        // the refetch after the first save never lands in time
        return ++mailGets === 1
          ? Promise.resolve({ enabled: [], available: ['a', 'b'], smtpAvailable: true })
          : new Promise(() => {})
      }
      if (url === '/api/auth/notify-prefs')
        return Promise.resolve({ push: [], available: ['a', 'b'], pushAvailable: false, freq: 'instant' })
      return Promise.resolve({})
    })
    const put = vi.spyOn(api, 'put').mockResolvedValue({})
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <Notifications />
      </QueryClientProvider>,
    )
    await screen.findByLabelText('settings.catByEmail settings.emailCat_a')
    const mailSwitch = (cat: string) =>
      screen.getByLabelText(`settings.catByEmail settings.emailCat_${cat}`) as HTMLInputElement
    fireEvent.click(mailSwitch('a'))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mailSwitch('b').disabled).toBe(false))
    fireEvent.click(mailSwitch('b'))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2))
    expect(put.mock.calls[1][1]).toEqual({ enabled: ['a', 'b'] })
  })
})
