import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { smoothRefresh } from '../smoothRefresh'

const doc = document as unknown as { startViewTransition?: unknown }

function watched(qc: QueryClient, fn: () => Promise<string>) {
  const obs = new QueryObserver(qc, { queryKey: ['k'], queryFn: fn, staleTime: Infinity })
  const off = obs.subscribe(() => {})
  return off
}

describe('smoothRefresh', () => {
  afterEach(() => {
    delete doc.startViewTransition
  })

  it('writes the new answers only inside the view transition', async () => {
    const qc = new QueryClient()
    let n = 0
    const off = watched(qc, async () => `v${++n}`)
    await vi.waitFor(() => expect(qc.getQueryData(['k'])).toBe('v1'))
    let inside: unknown = 'not run'
    doc.startViewTransition = vi.fn((cb: () => Promise<void>) => {
      inside = qc.getQueryData(['k'])
      return { finished: cb() }
    })
    await smoothRefresh(qc)
    expect(inside).toBe('v1')
    expect(qc.getQueryData(['k'])).toBe('v2')
    off()
  })

  it('refetches the plain way without view transitions', async () => {
    const qc = new QueryClient()
    let n = 0
    const off = watched(qc, async () => `v${++n}`)
    await vi.waitFor(() => expect(qc.getQueryData(['k'])).toBe('v1'))
    await smoothRefresh(qc)
    expect(qc.getQueryData(['k'])).toBe('v2')
    off()
  })
})
