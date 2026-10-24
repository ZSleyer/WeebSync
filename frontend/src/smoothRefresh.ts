import type { QueryClient, QueryFunction, QueryKey } from '@tanstack/react-query'

/** how long the live page waits for new pictures to decode before the swap */
const DECODE_CAP_MS = 600
/** how long the refresh waits for answers before it swaps what it has */
export const REFRESH_CAP_MS = 1500

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

/** How many queries the refresh asked and how many of them failed. */
export interface RefreshResult {
  total: number
  failed: number
}

/**
 * Reloads what the page shows and lands it in one go: every active query is
 * fetched first, out of sight, the pictures new in the answers are decoded
 * while the page stays live (the spinner keeps turning), then `beforeSwap`
 * sets the caller's final state (a done mark) and all the answers are written
 * at once, so a new hero banner and the counts beside it change together
 * with their pictures ready instead of popping in one by one. No view
 * transition: it shows a still picture of the page while it runs, and on a
 * phone that was a frozen screen with the done mark caught before its tick
 * appeared. A query it cannot fetch on its own (an infinite list) refetches
 * the plain way.
 */
export async function smoothRefresh(
  qc: QueryClient,
  beforeSwap?: (result: RefreshResult) => void | Promise<void>,
): Promise<RefreshResult> {
  const started = Date.now()
  const queries = qc.getQueryCache().findAll({ type: 'active' })
  const plain = queries.filter((q) => typeof q.options.queryFn !== 'function' || 'pages' in Object(q.state.data))
  const quiet = queries.filter((q) => !plain.includes(q))
  const fetches = quiet.map((q) => {
    const fn = q.options.queryFn as QueryFunction<unknown, QueryKey>
    const signal = new AbortController().signal
    return Promise.resolve(fn({ queryKey: q.queryKey, signal, meta: q.meta, client: qc } as never))
  })
  // one slow answer must not hold the whole page: what is in by the
  // deadline lands together, a straggler lands on its own later
  const deadline = new Promise<'late'>((r) => setTimeout(() => r('late'), REFRESH_CAP_MS))
  // a failure is shown to the caller, and an expired session (401) reaches the
  // cache's own error handler, as it would from a normal fetch
  let failed = 0
  const onError = qc.getQueryCache().config.onError
  const fail = (i: number) => (e: unknown) => {
    failed++
    onError?.(e as never, quiet[i] as never)
    return undefined
  }
  // newer data (the event stream, a poll) that landed while this one was on
  // its way is not overwritten with the older answer
  const write = (i: number, value: unknown) => {
    if (quiet[i].state.dataUpdatedAt > started) return
    qc.setQueryData(quiet[i].queryKey, value)
  }
  const got = await Promise.all(
    fetches.map((p, i) => Promise.race([p.then((value) => ({ value }), fail(i)), deadline])),
  )
  got.forEach((r, i) => {
    if (r === 'late')
      fetches[i].then(
        (v) => write(i, v),
        () => {},
      )
  })
  await Promise.race([
    Promise.allSettled(plain.map((q) => qc.refetchQueries({ queryKey: q.queryKey, exact: true }))),
    deadline,
  ])
  failed += plain.filter((q) => q.state.status === 'error').length
  const result = { total: queries.length, failed }
  const arrived = got.flatMap((r, i) => (r && r !== 'late' ? [{ q: quiet[i], i, value: r.value }] : []))
  await decodeAll(arrived.flatMap(({ q, value }) => newImageUrls(q.state.data, value)))
  await beforeSwap?.(result)
  arrived.forEach(({ i, value }) => write(i, value))
  return result
}
