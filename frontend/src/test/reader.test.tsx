import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import Viewer from '../pages/Viewer'
import { api } from '../api'
import { AudioProvider } from '../components/AudioPlayer'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, unknown>) =>
        o && 'page' in o ? `${k}:${String(o.page)}/${String(o.count)}` : k,
      i18n: { language: 'de' },
    }) as never,
}))

const pic = (name: string) => ({ name, path: `/pics/${name}`, isDir: false, size: 1, modTime: '' })

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

function open() {
  vi.spyOn(api, 'get').mockResolvedValue([pic('a.jpg'), pic('b.jpg'), pic('c.jpg')] as never)
  // the first-open hint is shown once; not in these tests
  localStorage.setItem('viewer.hinted', '1')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/view?server=0&path=${encodeURIComponent('/pics/a.jpg')}`]}>
        <AudioProvider>
          <Viewer />
        </AudioProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// a tap at a share of the page's width
const tap = (el: HTMLElement, share: number) => {
  el.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    right: 100,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  fireEvent.click(el, { clientX: share * 100, clientY: 50 })
}

describe('reader', () => {
  it('covers the app, turns at the edges, shows the bars from the middle and ends after the last page', async () => {
    const { unmount } = open()
    expect(document.documentElement.classList.contains('reading')).toBe(true)
    const stage = await screen.findByRole('region', { name: 'a.jpg' })
    expect(screen.getByText('viewer.pageOf:1/3')).toBeInTheDocument()

    tap(stage, 0.9)
    await waitFor(() => expect(screen.getByText('viewer.pageOf:2/3')).toBeInTheDocument())
    tap(stage, 0.1)
    await waitFor(() => expect(screen.getByText('viewer.pageOf:1/3')).toBeInTheDocument())

    const frame = stage.parentElement as HTMLElement
    expect(frame).toHaveAttribute('data-chrome')
    tap(stage, 0.5)
    expect(frame).not.toHaveAttribute('data-chrome')
    tap(stage, 0.5)
    expect(frame).toHaveAttribute('data-chrome')

    fireEvent.keyDown(stage, { key: 'End' })
    fireEvent.keyDown(stage, { key: 'ArrowRight' })
    expect(await screen.findByText('reader.endReached')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'reader.overview' })).toBeInTheDocument()

    unmount()
    expect(document.documentElement.classList.contains('reading')).toBe(false)
  })

  it('names the reading direction and the pages sheet in the tools', async () => {
    open()
    await screen.findByRole('region', { name: 'a.jpg' })
    expect(screen.getByRole('button', { name: 'reader.dirIs' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'reader.pages' }))
    expect(await screen.findByRole('dialog', { name: 'reader.pages' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /viewer\.pageOf/ })).toHaveLength(3)
  })
})
