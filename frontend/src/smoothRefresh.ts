import type { QueryClient, QueryFunction, QueryKey } from '@tanstack/react-query'

/** how long the live page waits for new pictures to decode before the swap */
const DECODE_CAP_MS = 600

const reduced = () =>
  document.documentElement.dataset.motion === 'off' ||
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

const IMAGE_URL = /"((?:https?:\/\/|\/)[^"\s]+?\.(?:jpe?g|png|webp|avif|gif)(?:\?[^"\s]*)?)"/gi

/** The picture URLs in `next` that `prev` did not have: what a swap would load fresh. */
export function newImageUrls(prev: unknown, next: unknown): string[] {
  const had = new Set([...JSON.stringify(prev ?? null).matchAll(IMAGE_URL)].map((m) => m[1]))
  const fresh = new Set<string>()
  for (const m of JSON.stringify(next ?? null).matchAll(IMAGE_URL)) if (!had.has(m[1])) fresh.add(m[1])
  return [...fresh]
}

const decodeAll = (urls: string[]) =>
  Promise.race([
    Promise.all(
      urls.map((u) => {
        const img = new Image()
        img.decoding = 'async'
        img.src = u
        return img.decode().catch(() => {})
      }),
    ),
    new Promise((r) => setTimeout(r, DECODE_CAP_MS)),
  ])

/**
 * Reloads what the page shows and lands it in one cross-fade: every active
 * query is fetched first, out of sight, the pictures new in the answers are
 * decoded while the page is still live (a spinner keeps turning), and only
 * then are all the answers written at once inside a view transition, so a new
 * hero banner and the counts beside it fade over instead of jumping in one by
 * one. A view transition shows a still picture of the page while it runs, so
 * the wait happens before it and `beforeSwap` lets the caller set its final
 * state (a done mark) first. Without view transitions, with reduced motion,
 * or for a query it cannot fetch on its own (an infinite list), it refetches
 * the plain way.
 */
export async function smoothRefresh(qc: QueryClient, beforeSwap?: () => void | Promise<void>): Promise<void> {
  const queries = qc.getQueryCache().findAll({ type: 'active' })
  const plain = queries.filter((q) => typeof q.options.queryFn !== 'function' || 'pages' in Object(q.state.data))
  if (typeof document.startViewTransition !== 'function' || reduced()) {
    await qc.refetchQueries({ type: 'active' })
    await beforeSwap?.()
    return
  }
  const quiet = queries.filter((q) => !plain.includes(q))
  const got = await Promise.allSettled(
    quiet.map((q) => {
      const fn = q.options.queryFn as QueryFunction<unknown, QueryKey>
      const signal = new AbortController().signal
      return Promise.resolve(fn({ queryKey: q.queryKey, signal, meta: q.meta, client: qc } as never))
    }),
  )
  await Promise.allSettled(plain.map((q) => qc.refetchQueries({ queryKey: q.queryKey, exact: true })))
  await decodeAll(got.flatMap((r, i) => (r.status === 'fulfilled' ? newImageUrls(quiet[i].state.data, r.value) : [])))
  await beforeSwap?.()
  await frame()
  await document.startViewTransition(async () => {
    got.forEach((r, i) => {
      if (r.status === 'fulfilled') qc.setQueryData(quiet[i].queryKey, r.value)
    })
    // the cache tells its observers a tick later and React commits after
    // that: the new state is captured once both have run
    await new Promise((r) => setTimeout(r, 0))
    await frame()
  }).finished
}
