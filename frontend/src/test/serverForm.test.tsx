import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ServerFormPage } from '../pages/settings/Servers'
import { api, type ServerInfo } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

const real = window.matchMedia
beforeEach(() => {
  // a wide screen: the save bar renders in flow, not into the shell's footer row
  window.matchMedia = ((q: string) => ({
    matches: true,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
})
afterEach(() => {
  window.matchMedia = real
  vi.restoreAllMocks()
})

const SERVER = {
  id: 7,
  name: 'seedbox',
  protocol: 'sftp',
  host: 'sftp.example.com',
  port: 22,
  username: 'chisato',
  rootPath: '/anime',
  maxConnections: 4,
  icon: 'cloud',
  color: 'teal',
} as ServerInfo

const app = (path: string) => {
  vi.spyOn(api, 'get').mockImplementation(async () => [SERVER])
  const router = createMemoryRouter(
    [
      { path: '/settings/servers', element: <p>list</p> },
      { path: '/settings/servers/new', element: <ServerFormPage /> },
      { path: '/settings/servers/:id', element: <ServerFormPage /> },
    ],
    // the list behind the form, so leaving goes back to it as in the app
    { initialEntries: ['/settings/servers', path], initialIndex: 1 },
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('server form page', () => {
  it('lays the pickers out as twelve even cells', () => {
    app('/settings/servers/new')
    for (const name of ['servers.icon', 'servers.color']) {
      expect(within(screen.getByRole('group', { name })).getAllByRole('button')).toHaveLength(11)
    }
  })

  it('creates a server and returns to the list', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({})
    const router = app('/settings/servers/new')
    const form = document.getElementById('server-form') as HTMLFormElement
    const type = (name: string, value: string) =>
      fireEvent.change(form.elements.namedItem(name) as HTMLInputElement, { target: { value } })
    type('name', 'nas')
    type('host', 'nas.example.com')
    type('username', 'takina')
    type('password', 'secret-secret')
    fireEvent.click(within(screen.getByRole('group', { name: 'servers.color' })).getByLabelText('servers.colors.teal'))
    fireEvent.click(screen.getByRole('button', { name: 'servers.save' }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][1]).toMatchObject({ name: 'nas', host: 'nas.example.com', color: 'teal', icon: '' })
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/servers'))
  })

  it('edits the server of the address, filled in', async () => {
    app('/settings/servers/7')
    expect(await screen.findByDisplayValue('seedbox')).toBeInTheDocument()
    expect(screen.getByDisplayValue('sftp.example.com')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'servers.icon' })).getAllByRole('button')[2]).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('asks before an edited form is left, and keeps it on keep', async () => {
    const router = app('/settings/servers/new')
    const name = screen.getByLabelText('servers.name')
    fireEvent.change(name, { target: { value: 'half' } })
    fireEvent.input(name)
    fireEvent.click(screen.getByRole('button', { name: 'servers.cancel' }))
    expect(await screen.findByText('common.unsavedTitle')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings/servers/new')
    fireEvent.click(screen.getByText('common.keepEditing'))
    expect(router.state.location.pathname).toBe('/settings/servers/new')
    expect(screen.getByLabelText('servers.name')).toHaveValue('half')
  })
})
