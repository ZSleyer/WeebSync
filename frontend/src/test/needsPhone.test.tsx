import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { api } from '../api'
import { detectedLink } from '../pages/today/needs'
import { Needs } from '../pages/today/Needs'

// the toast runs its held-back action at once; the real one waits for the line to run out
vi.mock('../components/toast', () => ({
  useToast: () => (o: { commit?: () => void }) => o.commit?.(),
}))
vi.mock('../components/SeriesModal', () => ({
  useSeriesModal: () => ({ open: () => {} }),
}))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, unknown>) => (o?.count ? `${k}:${o.count}` : k),
    }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const Where = () => {
  const l = useLocation()
  return <p data-testid="where">{l.pathname + l.hash}</p>
}

function phone() {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.spyOn(api, 'get').mockResolvedValue([] as never)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Needs downloads={[]} watches={[]} detected={4} loading={false} />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Needs on a phone', () => {
  it('shows the action as an icon with its label and opens the list', async () => {
    phone()
    const btn = screen.getByRole('button', { name: /today\.needDetectedAct/ })
    expect(btn.textContent).toBe('')
    expect(btn.getAttribute('title')).toBe('today.needDetectedAct')
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(detectedLink(false)))
  })

  it('opens the row in full and runs the action from the sheet', async () => {
    phone()
    fireEvent.click(screen.getByText('today.needDetected:4').closest('button')!)
    const dialog = await screen.findByRole('dialog', { hidden: true })
    expect(dialog.textContent).toContain('today.needDetectedSub')
    expect(dialog.textContent).toContain('today.hide')
    const view = Array.from(dialog.querySelectorAll('button')).find((b) => /needDetectedAct/.test(b.textContent ?? ''))
    fireEvent.click(view!)
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(detectedLink(false)))
  })
})
