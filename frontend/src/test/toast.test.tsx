import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query'
import { ToastProvider, useUndoableRemove } from '../components/toast'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function List({ remove }: { remove: (id: number) => Promise<unknown> }) {
  const { data = [] } = useQuery<{ id: number }[]>({
    queryKey: ['things'],
    queryFn: async () => [{ id: 1 }, { id: 2 }],
  })
  const removeLater = useUndoableRemove()
  return (
    <ul>
      {data.map((x) => (
        <li key={x.id}>
          item {x.id}
          <button
            onClick={() =>
              removeLater({
                key: ['things'],
                match: (y: { id: number }) => y.id === x.id,
                message: `gone ${x.id}`,
                remove: () => remove(x.id),
              })
            }
          >
            del {x.id}
          </button>
        </li>
      ))}
    </ul>
  )
}

const app = (remove: (id: number) => Promise<unknown>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <List remove={remove} />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

describe('undoable removal', () => {
  it('hides the row at once and sends the removal only when the line runs out', async () => {
    const remove = vi.fn(async () => {})
    app(remove)
    await act(() => vi.runOnlyPendingTimersAsync())
    fireEvent.click(screen.getByText('del 1'))
    // react-query hands the change to its observers on the next tick
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.queryByText(/item 1/)).toBeNull()
    expect(screen.getByText('gone 1')).toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(remove).toHaveBeenCalledOnce()
  })

  it('puts the row back on undo and never sends the removal', async () => {
    const remove = vi.fn(async () => {})
    app(remove)
    await act(() => vi.runOnlyPendingTimersAsync())
    fireEvent.click(screen.getByText('del 2'))
    // jsdom has no popover API: the region counts as hidden to role queries
    fireEvent.click(screen.getByText('common.undo'))
    await act(() => vi.advanceTimersByTimeAsync(6000))
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByText(/item 2/)).toBeInTheDocument()
  })

  it('sends the first removal at once when a second one replaces its line', async () => {
    const remove = vi.fn(async () => {})
    app(remove)
    await act(() => vi.runOnlyPendingTimersAsync())
    fireEvent.click(screen.getByText('del 1'))
    fireEvent.click(screen.getByText('del 2'))
    expect(remove).toHaveBeenCalledOnce()
  })

  // The failure line of the first removal used to replace the second one's
  // line the way any line does: it sent the second removal at once and took
  // its Undo away.
  it('keeps the next removal and its undo when the one before fails', async () => {
    let rejectFirst: (e: unknown) => void = () => {}
    const remove = vi.fn((id: number) =>
      id === 1
        ? new Promise((_, rej) => {
            rejectFirst = rej
          })
        : Promise.resolve(),
    )
    app(remove)
    await act(() => vi.runOnlyPendingTimersAsync())
    fireEvent.click(screen.getByText('del 1'))
    fireEvent.click(screen.getByText('del 2')) // sends removal 1
    await act(async () => {
      rejectFirst(new Error('boom'))
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(screen.getByText('common.undoFailed')).toBeInTheDocument()
    expect(screen.getByText('gone 2')).toBeInTheDocument()
    expect(remove).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('common.undo'))
    await act(() => vi.advanceTimersByTimeAsync(6000))
    expect(remove).toHaveBeenCalledTimes(1)
  })
})

describe('failed mutations', () => {
  function Act({ own }: { own?: boolean }) {
    const m = useMutation({
      mutationFn: () => Promise.reject(new Error('nope')),
      ...(own ? { onError: () => {} } : {}),
    })
    return <button onClick={() => m.mutate()}>go</button>
  }
  const mount = (own?: boolean) => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <Act own={own} />
        </ToastProvider>
      </QueryClientProvider>,
    )
  }

  it('say so on a line of their own', async () => {
    mount()
    fireEvent.click(screen.getByText('go'))
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(screen.getByText('common.actionFailed')).toBeInTheDocument()
  })

  it('stay quiet when the mutation handles its own error', async () => {
    mount(true)
    fireEvent.click(screen.getByText('go'))
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(screen.queryByText('common.actionFailed')).toBeNull()
  })
})
