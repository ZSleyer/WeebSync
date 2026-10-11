import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { useWholeSave } from '../hooks'

type Prefs = { push: string[] }

function setup(save: (p: Prefs) => Promise<unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let server: Prefs = { push: ['a', 'b'] }
  qc.setQueryData(['prefs'], server)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  // the page's query, so the refetch after saving reads the server
  const { result } = renderHook(
    () => {
      useQuery({ queryKey: ['prefs'], queryFn: () => server, staleTime: Infinity })
      return useWholeSave<Prefs>('prefs', save)
    },
    { wrapper },
  )
  return { qc, result, setServer: (p: Prefs) => (server = p) }
}

const toggle = (cat: string) => (p: Prefs) => ({
  push: p.push.includes(cat) ? p.push.filter((c) => c !== cat) : [...p.push, cat],
})

describe('useWholeSave', () => {
  it('builds each save on the previous one and sends them in order', async () => {
    const sent: Prefs[] = []
    const gates: (() => void)[] = []
    const { qc, result, setServer } = setup(
      (p) =>
        new Promise((done) => {
          sent.push(p)
          gates.push(() => {
            setServer(p)
            done(null)
          })
        }),
    )
    act(() => result.current(toggle('a')))
    act(() => result.current(toggle('b')))
    expect(qc.getQueryData(['prefs'])).toEqual({ push: [] })
    // the second PUT waits for the first
    await waitFor(() => expect(sent).toHaveLength(1))
    await act(async () => gates[0]())
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent).toEqual([{ push: ['b'] }, { push: [] }])
    // no refetch between the two, which would show the first state again
    expect(qc.getQueryData(['prefs'])).toEqual({ push: [] })
    await act(async () => gates[1]())
    await waitFor(() => expect(qc.getQueryData(['prefs'])).toEqual({ push: [] }))
  })

  it('falls back to the server state when a save fails', async () => {
    const { qc, result } = setup(() => Promise.reject(new Error('boom')))
    act(() => result.current(toggle('c')))
    expect(qc.getQueryData(['prefs'])).toEqual({ push: ['a', 'b', 'c'] })
    await waitFor(() => expect(qc.getQueryData(['prefs'])).toEqual({ push: ['a', 'b'] }))
  })
})
