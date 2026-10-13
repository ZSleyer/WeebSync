import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PhoneHint, { qrPath } from '../components/PhoneHint'
import { api } from '../api'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

describe('qrPath', () => {
  it('draws a version-sized code with its three finder squares', () => {
    const { size, d } = qrPath('https://weebsync.example.com')
    expect(size).toBe(29) // version 3 at level M holds this address
    // the top-left finder starts with a dark module at the very corner
    expect(d.startsWith('M0 0h1v1h-1z')).toBe(true)
  })
})

describe('PhoneHint', () => {
  afterEach(() => vi.restoreAllMocks())

  const mount = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <PhoneHint />
      </QueryClientProvider>,
    )
    return qc
  }

  it('stays away once closed', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ dismissed: ['mobile-ui'] })
    const qc = mount()
    await waitFor(() => expect(qc.getQueryState(['tips'])?.status).toBe('success'))
    expect(screen.queryByText('tips.phone')).toBeNull()
  })

  it('closes for good and tells the server', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ dismissed: [] })
    const post = vi.spyOn(api, 'post').mockResolvedValue({ status: 'ok' })
    mount()
    expect(await screen.findByText('tips.phone')).toBeInTheDocument()
    // jsdom has no popover: the button is reached without opening it
    HTMLElement.prototype.hidePopover ??= () => {}
    fireEvent.click(screen.getByRole('button', { name: 'tips.phoneOff', hidden: true }))
    await waitFor(() => expect(screen.queryByText('tips.phone')).toBeNull())
    expect(post).toHaveBeenCalledWith('/api/auth/tips/dismiss', { key: 'mobile-ui' })
  })
})
