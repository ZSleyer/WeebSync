import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { ToastProvider, useUndoableRemove } from '../components/toast'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function List({ remove }: { remove: () => Promise<unknown> }) {
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
                remove,
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

const app = (remove: () => Promise<unknown>) => {
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
})
