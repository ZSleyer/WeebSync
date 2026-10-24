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
  return qc
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
    // a line with an undo stays at least 8s
    await act(() => vi.advanceTimersByTimeAsync(7900))
    expect(remove).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(remove).toHaveBeenCalledOnce()
  })

  it('holds the time while the line is hovered, and sends on close or Escape', async () => {
    const remove = vi.fn(async () => {})
    app(remove)
    await act(() => vi.runOnlyPendingTimersAsync())
    fireEvent.click(screen.getByText('del 1'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    const line = screen.getByText('gone 1').closest('.t-toast')!
    fireEvent.pointerEnter(line, { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.pointerLeave(line)
    await act(() => vi.advanceTimersByTimeAsync(7000))
    expect(remove).not.toHaveBeenCalled()
    // Escape with the focus inside closes it, and the removal goes through
    fireEvent.keyDown(screen.getByText('common.undo'), { key: 'Escape' })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(remove).toHaveBeenCalledOnce()
    expect(screen.queryByText('gone 1')).toBeNull()
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

  it('keeps a pending row hidden when a manual cache write (pull to refresh) brings it back', async () => {
    const remove = vi.fn(async () => {})
    const qc = app(remove)
    await act(() => vi.runOnlyPendingTimersAsync())
    fireEvent.click(screen.getByText('del 1'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(async () => {
      qc.setQueryData(['things'], [{ id: 1 }, { id: 2 }])
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.queryByText(/item 1/)).toBeNull()
    expect(screen.getByText(/item 2/)).toBeInTheDocument()
  })

  it('undoes with Ctrl+Z from anywhere, but leaves a text field its own undo', async () => {
    const remove = vi.fn(async () => {})
    app(remove)
    await act(() => vi.runOnlyPendingTimersAsync())
    fireEvent.click(screen.getByText('del 1'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    const field = document.body.appendChild(document.createElement('input'))
    fireEvent.keyDown(field, { key: 'z', ctrlKey: true })
    expect(screen.queryByText(/item 1/)).toBeNull()
    field.remove()
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByText(/item 1/)).toBeInTheDocument()
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
    // a failure is announced assertively, not through the polite region
    expect(screen.getByText('common.actionFailed').closest('[role=alert]')).not.toBeNull()
    expect(screen.getByText('common.actionFailed').closest('[role=status]')).toBeNull()
  })

  it('stay quiet when the mutation handles its own error', async () => {
    mount(true)
    fireEvent.click(screen.getByText('go'))
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(screen.queryByText('common.actionFailed')).toBeNull()
  })
})
