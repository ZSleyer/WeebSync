import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { kindGroup, NameTester, SAMPLES, segments } from '../components/NameTester'
import Rules from '../pages/settings/Rules'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
  Trans: (({ i18nKey }: { i18nKey: string }) => i18nKey) as never,
}))

afterEach(() => vi.restoreAllMocks())

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('kindGroup', () => {
  it('paints the server kinds in the tester groups', () => {
    expect(kindGroup('title')).toBe('title')
    expect(kindGroup('alt')).toBe('alt')
    for (const k of ['season', 'final', 'movie', 'ova']) expect(kindGroup(k)).toBe('season')
    for (const k of ['episode', 'version']) expect(kindGroup(k)).toBe('ep')
    expect(kindGroup('year')).toBe('year')
    for (const k of ['dub', 'sub']) expect(kindGroup(k)).toBe('lang')
    expect(kindGroup('resolution')).toBe('res')
    for (const k of ['group', 'tag', 'extension', 'unknown']) expect(kindGroup(k)).toBe('other')
  })
})

describe('segments', () => {
  it('cuts at UTF-16 offsets and skips unplaced or overlapping pieces', () => {
    const name = 'Chäos;Child S2 [GerSub]'
    const s = segments(name, [
      { kind: 'title', value: 'Chäos;Child', start: 0, end: 11 },
      { kind: 'season', value: '2', start: 12, end: 14 },
      { kind: 'episode', value: '7', start: -1, end: -1 },
      { kind: 'tag', value: 'S', start: 12, end: 13 },
      { kind: 'sub', value: 'GerSub', start: 16, end: 22 },
    ])
    expect(s.map((x) => x.text).join('')).toBe(name)
    expect(s.filter((x) => x.piece !== undefined).map((x) => [x.text, x.piece])).toEqual([
      ['Chäos;Child', 0],
      ['S2', 1],
      ['GerSub', 4],
    ])
  })
})

describe('NameTester', () => {
  it('starts on a sample, paints the pieces and lists them', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      pieces: [{ kind: 'season', value: '3', start: 23, end: 33 }],
      parse: { title: 'Kusuriya no Hitorigoto', full: '', season: 3 },
    })
    const { container } = wrap(<NameTester />)
    const field = screen.getByLabelText('explain.rules.tester', { selector: 'textarea' }) as HTMLTextAreaElement
    expect(field.value).toBe(SAMPLES[0][1])
    await screen.findByText('3rd Season', { selector: '.ws-tk' })
    expect(container.querySelector('.ws-tk')?.getAttribute('data-k')).toBe('season')
    expect(container.querySelector('.ws-trace li')?.textContent).toBe('explain.piece.season3')
    fireEvent.click(screen.getByText('explain.rules.samples.roman'))
    expect(field.value).toBe(SAMPLES[2][1])
    expect(post).toHaveBeenCalled()
  })
})

describe('Rules', () => {
  it('has a section per anchor the explanations link to', () => {
    vi.spyOn(api, 'post').mockResolvedValue({ pieces: [], parse: {} })
    const { container } = wrap(<Rules />)
    for (const id of ['names', 'scope', 'match', 'bundle', 'sync', 'files'])
      expect(container.querySelector(`#r-${id} > h2`)).toBeTruthy()
    // one h1, the sections under it
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(container.querySelectorAll('.ws-skips li')).toHaveLength(8)
  })
})
