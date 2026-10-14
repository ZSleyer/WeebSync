import type { QueryClient, QueryFunction, QueryKey } from '@tanstack/react-query'

/** how long the live page waits for new pictures to decode before the swap */
const DECODE_CAP_MS = 600
/** how long the refresh waits for answers before it swaps what it has */
export const REFRESH_CAP_MS = 1500

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
    // the answers land as they come; the done mark waits no longer than the cap
    await Promise.race([qc.refetchQueries({ type: 'active' }), new Promise((r) => setTimeout(r, REFRESH_CAP_MS))])
    await beforeSwap?.()
    return
  }
  const quiet = queries.filter((q) => !plain.includes(q))
  const fetches = quiet.map((q) => {
    const fn = q.options.queryFn as QueryFunction<unknown, QueryKey>
    const signal = new AbortController().signal
    return Promise.resolve(fn({ queryKey: q.queryKey, signal, meta: q.meta, client: qc } as never))
  })
  // one slow answer must not hold the whole page: what is in by the
  // deadline goes into the cross-fade, a straggler lands on its own later
  const deadline = new Promise<'late'>((r) => setTimeout(() => r('late'), REFRESH_CAP_MS))
  const got = await Promise.all(
    fetches.map((p) =>
      Promise.race([
        p.then(
          (value) => ({ value }),
          () => undefined,
        ),
        deadline,
      ]),
    ),
  )
  got.forEach((r, i) => {
    if (r === 'late')
      fetches[i].then(
        (v) => qc.setQueryData(quiet[i].queryKey, v),
        () => {},
      )
  })
  await Promise.race([
    Promise.allSettled(plain.map((q) => qc.refetchQueries({ queryKey: q.queryKey, exact: true }))),
    deadline,
  ])
  const arrived = got.flatMap((r, i) => (r && r !== 'late' ? [{ q: quiet[i], value: r.value }] : []))
  await decodeAll(arrived.flatMap(({ q, value }) => newImageUrls(q.state.data, value)))
  await beforeSwap?.()
  await frame()
  await document.startViewTransition(async () => {
    arrived.forEach(({ q, value }) => qc.setQueryData(q.queryKey, value))
    // the cache tells its observers a tick later and React commits after
    // that: the new state is captured once both have run
    await new Promise((r) => setTimeout(r, 0))
    await frame()
  }).finished
}
