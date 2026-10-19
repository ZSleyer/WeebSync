import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { api } from '../api'
import { buildNeeds, detectedLink } from '../pages/today/needs'
import { Needs } from '../pages/today/Needs'

// the toast runs its held-back action at once; the real one waits for the line to run out
vi.mock('../components/toast', () => ({ useToast: () => (o: { commit?: () => void }) => o.commit?.() }))
vi.mock('../components/SeriesModal', () => ({ useSeriesModal: () => ({ open: () => {} }) }))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({ t: (k: string, o?: Record<string, unknown>) => (o?.count ? `${k}:${o.count}` : k) }) as never,
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

describe('the folders WeebSync marked on its own', () => {
  it('are one summary row with their count, in the decisions group, and nothing without any', () => {
    const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k)
    const rows = buildNeeds(t, { downloads: [], watches: [], detected: 23, now: 0 })
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('marks')
    expect(rows[0].title).toBe('today.needDetected:{"count":23}')
    expect(rows[0].act).toBe('today.needDetectedAct')
    expect(buildNeeds(t, { downloads: [], watches: [], detected: 0, now: 0 })).toEqual([])
  })

  it('open the list with the one action; no mark is written from the row', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    vi.spyOn(api, 'get').mockResolvedValue([] as never)
    const put = vi.spyOn(api, 'put').mockResolvedValue({} as never)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<Needs downloads={[]} watches={[]} detected={23} loading={false} />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByText('today.needDetected:23')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /today\.needDetectedAct/ }))
    expect((await screen.findByTestId('where')).textContent).toBe(detectedLink(false))
    expect(put).not.toHaveBeenCalled()
  })
})
