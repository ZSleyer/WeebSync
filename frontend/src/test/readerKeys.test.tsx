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

describe('reader keys', () => {
  it('leaves Alt/Ctrl/Meta+arrow to the browser', async () => {
    open()
    const stage = await screen.findByRole('region', { name: 'a.jpg' })
    for (const mod of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      // true: nobody called preventDefault, so back/forward still happens
      expect(fireEvent.keyDown(stage, { key: 'ArrowRight', ...mod })).toBe(true)
      expect(fireEvent.keyDown(stage, { key: 'ArrowLeft', ...mod })).toBe(true)
    }
    expect(screen.getByText('viewer.pageOf:1/3')).toBeInTheDocument()
  })

  it('turns forward on Space and back on Shift+Space', async () => {
    open()
    const stage = await screen.findByRole('region', { name: 'a.jpg' })
    fireEvent.keyDown(stage, { key: ' ' })
    await waitFor(() => expect(screen.getByText('viewer.pageOf:2/3')).toBeInTheDocument())
    fireEvent.keyDown(stage, { key: ' ', shiftKey: true })
    await waitFor(() => expect(screen.getByText('viewer.pageOf:1/3')).toBeInTheDocument())
  })
})
