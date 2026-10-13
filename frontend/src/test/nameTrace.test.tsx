import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NameTrace } from '../components/NameTrace'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => vi.restoreAllMocks())

describe('NameTrace', () => {
  it('marks the pieces at their UTF-16 offsets and lists every piece', async () => {
    // "Chäos;Child S2 [GerSub]": the ä is one UTF-16 unit, the offsets count it so
    const name = 'Chäos;Child S2 [GerSub]'
    vi.spyOn(api, 'post').mockResolvedValue({
      pieces: [
        { kind: 'title', value: 'Chäos;Child', start: 0, end: 11 },
        { kind: 'season', value: '2', start: 12, end: 14 },
        { kind: 'sub', value: 'GerSub', start: 16, end: 22 },
        { kind: 'episode', value: '7', start: -1, end: -1 },
      ],
      parse: { title: 'Chäos;Child', full: 'Chäos;Child S2', season: 2 },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <NameTrace name={name} />
      </QueryClientProvider>,
    )
    await screen.findByText('Chäos;Child', { selector: 'mark' })
    const marks = [...container.querySelectorAll('mark')].map((m) => m.textContent)
    expect(marks).toEqual(['Chäos;Child', 'S2', 'GerSub'])
    // the name reads whole, marks and gaps together
    expect(container.querySelector('p')?.textContent).toBe(name)
    // a piece without a position is listed, not marked
    expect(screen.getByText('explain.piece.episode')).toBeTruthy()
  })
})
