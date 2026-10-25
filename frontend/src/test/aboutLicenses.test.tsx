import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ThirdPartyLicenses, { loadOsList } from '../pages/settings/Licenses'
import inventory from '../licenses/inventory.json'
import texts from '../licenses/texts.json'

const html = () => new Response('<!doctype html><title>WeebSync</title>', { headers: { 'content-type': 'text/html' } })
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })

function renderLicenses() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThirdPartyLicenses />
    </QueryClientProvider>,
  )
}

// opens a native details through its summary, as a click does in a browser
function openDetails(summaryText: string) {
  const summary = screen.getByText(summaryText).closest('summary')!
  const details = summary.parentElement as HTMLDetailsElement
  details.open = true
  fireEvent(details, new Event('toggle'))
}

describe('third-party licenses on the About page', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads nothing until the section is opened', () => {
    const fetchMock = vi.fn(() => Promise.resolve(html()))
    vi.stubGlobal('fetch', fetchMock)
    renderLicenses()
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lists the committed inventory by source, searchable, with the text on demand', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(html())),
    )
    renderLicenses()
    openDetails('about.licenses.title')
    const search = await screen.findByRole('searchbox')
    expect(screen.getByRole('status')).toHaveTextContent('about.licenses.count')

    fireEvent.change(search, { target: { value: 'react-dom' } })
    const link = await screen.findByRole('link', { name: /^react-dom/ })
    const entry = inventory.find((e) => e.name === 'react-dom')!
    expect(link).toHaveAttribute('href', entry.url)
    // the matching group opens while searching
    const row = link.closest('li')!
    expect(within(row).getByText(entry.license)).toBeInTheDocument()

    const toggle = within(row).getByRole('button', { name: 'about.licenses.textOf' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const text = await within(row).findByRole('region', { name: 'about.licenses.textOf' })
    expect(text.textContent).toBe((texts as Record<string, string>)[entry.text!])
  })

  it('shows the image OS packages only when the image dropped its list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(html())),
    )
    expect(await loadOsList()).toEqual([])

    const os = [
      { name: 'libass9', version: '1:0.17.3-1', license: 'ISC', url: 'https://tracker.debian.org/pkg/libass' },
      { name: 'bad', version: '1', license: 'MIT', url: 'http://insecure.example' },
      { name: 'incomplete' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(os))),
    )
    expect(await loadOsList()).toEqual([{ ...os[0], source: 'os' }])

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 404 }))),
    )
    expect(await loadOsList()).toEqual([])
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    )
    expect(await loadOsList()).toEqual([])

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json({ entries: os }))),
    )
    renderLicenses()
    openDetails('about.licenses.title')
    await waitFor(() => expect(screen.getByText('about.licenses.source.os')).toBeInTheDocument())
  })
})
