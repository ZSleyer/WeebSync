import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DevicesSection, formatDeviceCode } from '../pages/settings/Devices'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, string>) => (o ? `${k} ${Object.values(o).join(' ')}` : k),
      i18n: { language: 'en' },
    }) as never,
}))
const confirmFn = vi.hoisted(() => vi.fn(async (_o: { message?: string }) => true))
vi.mock('../components/confirm', () => ({ useConfirm: () => confirmFn }))

afterEach(() => {
  vi.restoreAllMocks()
  confirmFn.mockClear()
})

function setup(devices: unknown[] = []) {
  let list = devices
  const get = vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/devices') return list as never
    return {} as never
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async () => {
    list = [{ id: 9, name: 'Kotatsu', scope: 'tv:read', createdAt: '2026-10-25T10:00:00Z' }]
    return { name: 'Kotatsu' } as never
  })
  const del = vi.spyOn(api, 'del').mockImplementation(async () => {
    list = []
    return { status: 'ok' } as never
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DevicesSection />
    </QueryClientProvider>,
  )
  return { get, post, del, panel: within(screen.getByRole('region', { name: 'devices.title' })) }
}

describe('formatDeviceCode', () => {
  it('reads a typed code the way the server does', () => {
    expect(formatDeviceCode('wdjbmjht')).toBe('WDJB-MJHT')
    expect(formatDeviceCode(' wd jb-mj ht ')).toBe('WDJB-MJHT')
    expect(formatDeviceCode('WDJ')).toBe('WDJ')
    expect(formatDeviceCode('WDJB-MJHTX')).toBe('WDJB-MJHT')
    // vowels and digits are not in the alphabet
    expect(formatDeviceCode('A1E2WDJB')).toBe('WDJB')
  })
})

describe('Devices panel', () => {
  it('links a device by its code and lists it', async () => {
    const { post, panel } = setup()
    expect(await panel.findByText('devices.none')).toBeInTheDocument()
    const input = panel.getByLabelText('devices.code')
    fireEvent.change(input, { target: { value: 'wdjbmjht' } })
    expect(input).toHaveValue('WDJB-MJHT')
    fireEvent.click(panel.getByRole('button', { name: 'devices.link' }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/devices/approve', { userCode: 'WDJB-MJHT' }))
    expect(await panel.findByRole('status')).toHaveTextContent('devices.linked Kotatsu')
    expect(await panel.findByText('Kotatsu')).toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('refuses an incomplete code without asking the server, and says why', async () => {
    const { post, panel } = setup()
    const input = panel.getByLabelText('devices.code')
    fireEvent.change(input, { target: { value: 'WDJB' } })
    fireEvent.click(panel.getByRole('button', { name: 'devices.link' }))
    expect(await panel.findByRole('alert')).toHaveTextContent('devices.codeIncomplete')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.getAttribute('aria-describedby')).toContain(panel.getByRole('alert').id)
    expect(post).not.toHaveBeenCalled()
  })

  it('shows a refused code as an alert', async () => {
    const { post, panel } = setup()
    post.mockRejectedValueOnce(new Error('unknown or expired code'))
    fireEvent.change(panel.getByLabelText('devices.code'), { target: { value: 'BBBBBBBB' } })
    fireEvent.click(panel.getByRole('button', { name: 'devices.link' }))
    expect(await panel.findByRole('alert')).toHaveTextContent('unknown or expired code')
  })

  it('lists devices with their last use and revokes one after confirming', async () => {
    const { del, panel } = setup([
      {
        id: 3,
        name: 'Wohnzimmer',
        scope: 'tv:read',
        createdAt: '2026-10-01T10:00:00Z',
        lastUsedAt: new Date(Date.now() - 3600_000).toISOString(),
        lastIp: '192.168.1.20',
      },
      { id: 4, name: 'Neu', scope: 'tv:read', createdAt: '2026-10-02T10:00:00Z' },
    ])
    const list = await panel.findByRole('list', { name: 'devices.listLabel' })
    expect(within(list).getByText(/devices\.lastUsed/)).toHaveTextContent('192.168.1.20')
    expect(within(list).getByText(/devices\.neverUsed/)).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('button', { name: 'devices.revoke: Wohnzimmer' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/devices/3'))
    expect(confirmFn).toHaveBeenCalledTimes(1)
  })

  it('keeps the device when the confirmation is declined', async () => {
    const { del, panel } = setup([{ id: 3, name: 'TV', scope: 'tv:read', createdAt: '2026-10-01T10:00:00Z' }])
    confirmFn.mockResolvedValueOnce(false)
    fireEvent.click(await panel.findByRole('button', { name: 'devices.revoke: TV' }))
    await waitFor(() => expect(confirmFn).toHaveBeenCalled())
    expect(del).not.toHaveBeenCalled()
  })
})
