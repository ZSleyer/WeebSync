import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter, useLocation, useNavigationType } from 'react-router'
import type { ReactNode } from 'react'
import { useLeaveParams, useUrlState } from '../hooks/useUrlState'

// the hook reads and writes window.location through the router's navigate, so
// the router has to be the one that owns the window's history
import { createBrowserRouter, RouterProvider } from 'react-router'
import { render } from '@testing-library/react'

function Probe({ onReady }: { onReady: (api: ReturnType<typeof useProbe>) => void }) {
  const api = useProbe()
  onReady(api)
  return null
}
function useProbe() {
  const [q, setQ] = useUrlState('q')
  const [f, setF] = useUrlState('filter', 'all')
  const loc = useLocation()
  const type = useNavigationType()
  return { q, setQ, f, setF, loc, type }
}

const mount = async (url: string) => {
  history.replaceState(null, '', url)
  let latest!: ReturnType<typeof useProbe>
  const router = createBrowserRouter([{ path: '*', element: <Probe onReady={(a) => (latest = a)} /> }])
  render(<RouterProvider router={router} />)
  await act(async () => {})
  return { get: () => latest, router }
}

describe('useUrlState', () => {
  it('starts from the address and falls back to the default', async () => {
    const { get } = await mount('/history?q=frieren&filter=fail')
    expect(get().q).toBe('frieren')
    expect(get().f).toBe('fail')
    const bare = await mount('/history')
    expect(bare.get().q).toBe('')
    expect(bare.get().f).toBe('all')
  })

  it('replaces the entry as the text changes and drops the default', async () => {
    const { get } = await mount('/history')
    const before = history.length
    await act(async () => get().setQ('fri'))
    await act(async () => get().setQ('frie'))
    expect(window.location.search).toBe('?q=frie')
    expect(history.length).toBe(before)
    expect(get().type).toBe('REPLACE')
    await act(async () => get().setF('done'))
    expect(window.location.search).toBe('?q=frie&filter=done')
    await act(async () => get().setF('all'))
    expect(window.location.search).toBe('?q=frie')
    await act(async () => get().setQ(''))
    expect(window.location.search).toBe('')
    expect(history.length).toBe(before)
  })

  it('keeps two writes of one tick', async () => {
    const { get } = await mount('/history?q=a&filter=fail')
    await act(async () => {
      get().setQ('')
      get().setF('all')
    })
    expect(window.location.search).toBe('')
  })

  it('leaves the other parameters and the path alone', async () => {
    const { get } = await mount('/settings/data/x?store=1')
    await act(async () => get().setQ('abc'))
    expect(window.location.pathname).toBe('/settings/data/x')
    expect(window.location.search).toBe('?store=1&q=abc')
  })
})

describe('useLeaveParams', () => {
  it('takes its parameters off when it goes, on the same page', async () => {
    history.replaceState(null, '', '/files?tq=a&keep=1')
    function Host({ show }: { show: boolean }) {
      return show ? <Leaver /> : null
    }
    function Leaver() {
      useLeaveParams(['tq', 'th'])
      return null
    }
    const router = createBrowserRouter([{ path: '*', element: <Host show /> }])
    const r = render(<RouterProvider router={router} />)
    await act(async () => {})
    r.unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(window.location.search).toBe('?keep=1')
  })
})

// the memory router cannot show the window's address, but it proves the hook
// works without a data router around it as well
describe('useUrlState in a memory router', () => {
  const wrap = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={['/x?q=1']}>{children}</MemoryRouter>
  )
  it('reads its initial value', () => {
    history.replaceState(null, '', '/x?q=1')
    const { result } = renderHook(() => useUrlState('q'), { wrapper: wrap })
    expect(result.current[0]).toBe('1')
  })
})
