import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../api'
import { useThreadWrites, type ThreadData } from '../components/threadWrites'

vi.mock('../components/toast', () => ({ useToast: () => vi.fn(), useFailToast: () => vi.fn() }))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) as never,
}))

const comment = (id: number) => ({
  id,
  body: `c${id}`,
  likes: 0,
  isLiked: false,
  createdAt: 0,
  user: { name: 'u' },
  replies: [],
})
const seed = (): ThreadData => ({
  pageParams: [1],
  pages: [
    {
      thread: { id: 9, title: 't', body: 'b', replies: 0, views: 0, createdAt: 0, url: '', user: { name: 'op' }, likes: 0, isLiked: false },
      comments: [comment(1)],
      hasNextPage: false,
    },
  ],
})

afterEach(() => vi.restoreAllMocks())

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['anilist-me'], { connected: true, allow: { social: true }, name: 'me' })
  qc.setQueryData(['anilist-thread', 9], seed())
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const hook = renderHook(() => useThreadWrites(9), { wrapper })
  const ids = () => qc.getQueryData<ThreadData>(['anilist-thread', 9])!.pages[0].comments.map((c) => c.id)
  return { qc, hook, ids }
}

describe('thread write rollback', () => {
  it('a failed reply takes only itself back, not the reply written after it', async () => {
    let failA!: (e: Error) => void
    vi.spyOn(api, 'post').mockImplementation((_url: string, body?: unknown) => {
      const text = (body as { comment: string }).comment
      if (text === 'A') return new Promise((_, rej) => (failA = rej)) as never
      return new Promise(() => {}) as never
    })
    const { hook, ids } = setup()

    act(() => hook.result.current.open({ parent: 0, top: 0, name: 'op' }))
    act(() => hook.result.current.setDraft('A'))
    act(() => hook.result.current.send())
    await waitFor(() => expect(ids()).toHaveLength(2))
    act(() => hook.result.current.open({ parent: 0, top: 0, name: 'op' }))
    act(() => hook.result.current.setDraft('B'))
    act(() => hook.result.current.send())
    await waitFor(() => expect(ids()).toHaveLength(3))

    await act(async () => failA(new Error('429')))
    await waitFor(() => expect(ids()).toHaveLength(2))
    // the first comment and B are still there, A is gone
    expect(ids()[0]).toBe(1)
  })

  it('a failed like leaves a like given meanwhile on another comment alone', async () => {
    let failFirst!: (e: Error) => void
    vi.spyOn(api, 'post').mockImplementation((_url: string, body?: unknown) => {
      if ((body as { id: number }).id === 1) return new Promise((_, rej) => (failFirst = rej)) as never
      return new Promise(() => {}) as never
    })
    const { qc, hook } = setup()
    const d = qc.getQueryData<ThreadData>(['anilist-thread', 9])!
    d.pages[0].comments.push(comment(2))
    qc.setQueryData(['anilist-thread', 9], d)
    act(() => hook.result.current.like({ id: 1, type: 'THREAD_COMMENT' }))
    act(() => hook.result.current.like({ id: 2, type: 'THREAD_COMMENT' }))
    const liked = () => qc.getQueryData<ThreadData>(['anilist-thread', 9])!.pages[0].comments.map((c) => c.isLiked)
    await waitFor(() => expect(liked()).toEqual([true, true]))
    await act(async () => failFirst(new Error('boom')))
    await waitFor(() => expect(liked()).toEqual([false, true]))
  })
})
