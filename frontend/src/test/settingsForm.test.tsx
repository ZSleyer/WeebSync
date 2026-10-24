import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSettingsForm } from '../pages/settings/useSettingsForm'
import Downloads from '../pages/settings/Downloads'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({ t: (k: string, o?: Record<string, string>) => (o ? `${k} ${Object.values(o).join(' ')}` : k) }) as never,
}))

vi.mock('../components/PageActions', () => ({ PageFooter: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('../hooks/useUnsavedGuard', () => ({ UnsavedGuard: () => null }))

afterEach(() => vi.restoreAllMocks())

const base = { baseUrl: 'a', trustedProxies: '', maxConcurrent: 3, globalRateLimit: 0, envLocked: [] }

function setup() {
  vi.spyOn(api, 'get').mockResolvedValue({ ...base })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const hook = renderHook(() => useSettingsForm(), { wrapper })
  return { qc, hook }
}

describe('useSettingsForm edits', () => {
  it('keeps a concurrent server change out of the payload', async () => {
    const { qc, hook } = setup()
    const put = vi.spyOn(api, 'put').mockImplementation(async (_u, b) => ({ ...base, ...(b as object) }) as never)
    await waitFor(() => expect(hook.result.current.form).toBeTruthy())
    act(() => hook.result.current.set('trustedProxies', '10.0.0.1'))
    // another admin saved a new baseUrl, the refetch lands
    act(() => {
      qc.setQueryData(['settings'], { ...base, baseUrl: 'b' })
    })
    await waitFor(() => expect(hook.result.current.form?.baseUrl).toBe('b'))
    act(() => hook.result.current.save.mutate(hook.result.current.form!))
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(put.mock.calls[0][1]).toEqual(expect.objectContaining({ trustedProxies: '10.0.0.1' }))
    expect(put.mock.calls[0][1]).not.toHaveProperty('baseUrl')
  })

  it('keeps input typed while the save is in flight', async () => {
    const { hook } = setup()
    let release!: () => void
    vi.spyOn(api, 'put').mockImplementation(
      (_u, b) => new Promise((res) => (release = () => res({ ...base, ...(b as object) }) as never)),
    )
    await waitFor(() => expect(hook.result.current.form).toBeTruthy())
    act(() => hook.result.current.set('trustedProxies', '10.0.0.1'))
    act(() => hook.result.current.save.mutate(hook.result.current.form!))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    act(() => hook.result.current.set('baseUrl', 'typed'))
    await act(async () => release())
    await waitFor(() => expect(hook.result.current.save.isSuccess).toBe(true))
    expect(hook.result.current.form?.baseUrl).toBe('typed')
    expect(hook.result.current.dirty).toBe(true)
  })

  it('drops a field error once that field is edited', async () => {
    const { hook } = setup()
    vi.spyOn(api, 'put').mockRejectedValue(new Error('maxConcurrent: must be 1-20'))
    await waitFor(() => expect(hook.result.current.form).toBeTruthy())
    act(() => hook.result.current.set('maxConcurrent', 0))
    act(() => hook.result.current.save.mutate(hook.result.current.form!))
    await waitFor(() => expect(hook.result.current.issue('maxConcurrent')).toBe('must be 1-20'))
    act(() => hook.result.current.set('maxConcurrent', 5))
    expect(hook.result.current.issue('maxConcurrent')).toBeUndefined()
    expect(hook.result.current.save.error).toBeNull()
  })
})

describe('Downloads field error', () => {
  it('marks the field invalid when the save is refused', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ ...base })
    vi.spyOn(api, 'put').mockRejectedValue(new Error('maxConcurrent: must be 1-20'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <Downloads />
      </QueryClientProvider>,
    )
    const input = (await screen.findAllByRole('spinbutton'))[0]
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(screen.getByText('settings.save'))
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'))
  })
})
