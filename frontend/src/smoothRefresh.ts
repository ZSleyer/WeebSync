import type { QueryClient, QueryFunction, QueryKey } from '@tanstack/react-query'

const reduced = () =>
  document.documentElement.dataset.motion === 'off' ||
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

/** how long the fade waits for new pictures to decode */
const DECODE_CAP_MS = 600

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

/**
 * Reloads what the page shows and lands it in one cross-fade: every active
 * query is fetched first, out of sight, and only then are all the answers
 * written at once inside a view transition, so a new hero banner and the
 * counts beside it fade over instead of jumping in one by one. Without view
 * transitions, with reduced motion, or for a query it cannot fetch on its own
 * (an infinite list), it refetches the plain way.
 */
export async function smoothRefresh(qc: QueryClient): Promise<void> {
  const queries = qc.getQueryCache().findAll({ type: 'active' })
  const plain = queries.filter((q) => typeof q.options.queryFn !== 'function' || 'pages' in Object(q.state.data))
  if (typeof document.startViewTransition !== 'function' || reduced()) {
    await qc.refetchQueries({ type: 'active' })
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
  await document.startViewTransition(async () => {
    got.forEach((r, i) => {
      if (r.status === 'fulfilled') qc.setQueryData(quiet[i].queryKey, r.value)
    })
    // the cache tells its observers a tick later and React commits after
    // that: the new state is captured once both have run
    await new Promise((r) => setTimeout(r, 0))
    await frame()
    // pictures that came with the answer (a new banner, new covers) are
    // decoded before the new state is captured, or the fade lands on empty
    // panels and the pictures pop in after it; capped, a slow one pops
    const fresh = [...document.querySelectorAll<HTMLImageElement>('main img')].filter((i) => !i.complete)
    await Promise.race([
      Promise.all(fresh.map((i) => i.decode().catch(() => {}))),
      new Promise((r) => setTimeout(r, DECODE_CAP_MS)),
    ])
  }).finished
}
