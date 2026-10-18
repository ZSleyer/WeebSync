import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api, type CatalogItem } from '../api'
import { MatchHint } from '../components/MatchHint'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${o.title}:${o.year ?? ''}` : k) }) as never,
}))

afterEach(() => vi.restoreAllMocks())

const item = (extra: Partial<CatalogItem> = {}) =>
  ({
    entry: { name: 'Example Show [EngDub]', path: '/Area/Example Show [EngDub]', isDir: true },
    hint: { source: 'tmdb:tv', mediaId: 11, title: 'Example Show', year: 2017 },
    ...extra,
  }) as CatalogItem

const show = (it: CatalogItem, onTaken = vi.fn(), variant: 'row' | 'dialog' = 'row') => {
  const qc = new QueryClient()
  const inval = vi.spyOn(qc, 'invalidateQueries')
  render(
    <QueryClientProvider client={qc}>
      <MatchHint serverId={3} item={it} variant={variant} onTaken={onTaken} />
    </QueryClientProvider>,
  )
  return { inval, onTaken }
}

describe('MatchHint', () => {
  it('names the TMDB entry with its year', () => {
    show(item())
    expect(screen.getByText('catalog.hintFound:Example Show:2017')).toBeInTheDocument()
  })

  it('leaves out a year it does not have', () => {
    show(item({ hint: { source: 'tmdb:movie', mediaId: 7, title: 'Example Film' } }))
    expect(screen.getByText('catalog.hintFoundNoYear:Example Film:')).toBeInTheDocument()
  })

  it('shows nothing without a hint, or for a folder that has a match', () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MatchHint serverId={3} item={item({ hint: undefined })} variant="row" />
        <MatchHint serverId={3} item={item({ media: { id: 1 } as CatalogItem['media'] })} variant="row" />
      </QueryClientProvider>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('takes the hint through the ordinary manual match with the hint source', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({})
    const { inval, onTaken } = show(item(), vi.fn(), 'dialog')
    fireEvent.click(screen.getByText('catalog.hintTake'))
    await waitFor(() => expect(onTaken).toHaveBeenCalled())
    expect(put).toHaveBeenCalledWith('/api/servers/3/catalog/match', {
      folder: '/Area/Example Show [EngDub]',
      mediaId: 11,
      source: 'tmdb:tv',
    })
    expect(inval).toHaveBeenCalledWith({ queryKey: ['catalog', 3] })
  })

  it('drops the hint for good and takes it off the screen', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({})
    const put = vi.spyOn(api, 'put')
    show(item())
    fireEvent.click(screen.getByText('catalog.hintDrop'))
    await waitFor(() => expect(screen.queryByText('catalog.hintTake')).not.toBeInTheDocument())
    expect(post).toHaveBeenCalledWith('/api/servers/3/catalog/hint/dismiss', { folder: '/Area/Example Show [EngDub]' })
    expect(put).not.toHaveBeenCalled()
  })

  it('keeps the hint and says so when the call fails', async () => {
    vi.spyOn(api, 'put').mockRejectedValue(new Error('boom'))
    const { onTaken } = show(item())
    fireEvent.click(screen.getByText('catalog.hintTake'))
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
    expect(onTaken).not.toHaveBeenCalled()
    expect(screen.getByText('catalog.hintTake')).toBeEnabled()
  })
})
