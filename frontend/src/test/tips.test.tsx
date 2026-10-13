import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Tips, { installHint, pickTip } from '../components/Tips'
import { api } from '../api'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const phone = { desktop: false, touch: true, installed: false }
const desktop = { desktop: true, touch: false, installed: false }

describe('pickTip', () => {
  it('tells a desktop about the phone interface', () => {
    expect(pickTip(desktop, [])).toBe('mobile-ui')
  })

  it('offers the install on a phone browser, not in the installed app', () => {
    expect(pickTip(phone, [])).toBe('install-pwa')
    expect(pickTip({ ...phone, installed: true }, [])).toBeNull()
  })

  it('shows nothing once the hint is closed', () => {
    expect(pickTip(desktop, ['mobile-ui'])).toBeNull()
    expect(pickTip(phone, ['install-pwa'])).toBeNull()
  })

  it('shows one hint at a time, the next once the first is closed', () => {
    const both = { desktop: true, touch: true, installed: false }
    expect(pickTip(both, [])).toBe('mobile-ui')
    expect(pickTip(both, ['mobile-ui'])).toBe('install-pwa')
  })
})

describe('installHint', () => {
  it('tells the platforms apart', () => {
    expect(installHint('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe('ios')
    // iPadOS passes for a Mac; the touch points give it away
    expect(installHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios')
    expect(installHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('other')
    expect(installHint('Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0', 5)).toBe('firefox')
    expect(installHint('Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36', 5)).toBe('other')
  })
})

describe('Tips', () => {
  const real = window.matchMedia
  afterEach(() => {
    window.matchMedia = real
    vi.restoreAllMocks()
  })

  // a desktop: a mouse on a wide screen, in a browser tab
  const asDesktop = () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes('pointer: fine'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
  }

  const mount = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <Tips />
      </QueryClientProvider>,
    )
    return qc
  }

  it('shows nothing while the list is loading', () => {
    asDesktop()
    vi.spyOn(api, 'get').mockReturnValue(new Promise(() => {}))
    mount()
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('keeps a hint closed elsewhere hidden', async () => {
    asDesktop()
    vi.spyOn(api, 'get').mockResolvedValue({ dismissed: ['mobile-ui'] })
    const qc = mount()
    // past loading, so the empty page is the decision and not the wait
    await waitFor(() => expect(qc.getQueryState(['tips'])?.status).toBe('success'))
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('closes the hint at once and tells the server', async () => {
    asDesktop()
    vi.spyOn(api, 'get').mockResolvedValue({ dismissed: [] })
    const post = vi.spyOn(api, 'post').mockResolvedValue({ status: 'ok' })
    mount()
    expect(await screen.findByText('tips.mobileUi')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'tips.close' }))
    // the query cache tells its observers on the next tick
    await waitFor(() => expect(screen.queryByText('tips.mobileUi')).toBeNull())
    expect(post).toHaveBeenCalledWith('/api/auth/tips/dismiss', { key: 'mobile-ui' })
  })
})
