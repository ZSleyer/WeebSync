import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { api, ApiError, type ServerInfo } from '../api'
import FtpsMigrateDialog from '../components/FtpsMigrate'
import { buildNeeds, hiddenNeeds, hideForSession, saveHidden, sessionOnly } from '../pages/today/needs'
import { Needs } from '../pages/today/Needs'

vi.mock('../components/toast', () => ({ useToast: () => (o: { commit?: () => void }) => o.commit?.() }))
vi.mock('../components/SeriesModal', () => ({ useSeriesModal: () => ({ open: () => {} }) }))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.port ? `${k}:${o.port}` : k) }) as never,
}))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const srv = (extra: Partial<ServerInfo> = {}) =>
  ({
    id: 4,
    name: 'seedbox',
    protocol: 'ftp',
    host: 'ftp.example.com',
    port: 21,
    username: 'u',
    rootPath: '/',
    maxConnections: 3,
    icon: '',
    color: '',
    ...extra,
  }) as ServerInfo

const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k)
const build = (ftpServers: { id: number; name: string }[]) =>
  buildNeeds(t, { downloads: [], watches: [], hints: [], now: 0, ftpServers })

describe('the plain-FTP need', () => {
  it('is one error row per such server, ahead of everything else', () => {
    const rows = build([
      { id: 4, name: 'seedbox' },
      { id: 5, name: 'nas' },
    ])
    expect(rows.map((n) => n.key)).toEqual(['ftp-4', 'ftp-5'])
    expect(rows[0]).toMatchObject({
      kind: 'ftp',
      tone: 'err',
      title: 'today.needFtp:{"name":"seedbox"}',
      sub: 'today.needFtpSub',
      act: 'today.needFtpAct',
      serverId: 4,
    })
  })

  it('is no row when no server has the retired protocol', () => {
    expect(build([])).toEqual([])
  })

  it('is hidden for the session only, never stored for good', () => {
    const [row] = build([{ id: 4, name: 'seedbox' }])
    expect(sessionOnly(row)).toBe(true)
    hideForSession(row.print)
    expect(hiddenNeeds().has('ftp-4')).toBe(true)
    // saving the hidden set (as other rows do) leaves it out of the stored one
    saveHidden(hiddenNeeds(), [row])
    expect(localStorage.getItem('weebsync.today.hidden')).toBe('[]')
    // a new tab starts without it
    sessionStorage.clear()
    expect(hiddenNeeds().has('ftp-4')).toBe(false)
  })
})

function Where() {
  const l = useLocation()
  return <output data-testid="where">{l.pathname}</output>
}

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the Today row', () => {
  it('opens the dialog from "Switch" and hides only for the session', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    vi.spyOn(api, 'get').mockResolvedValue([srv()] as never)
    wrap(<Needs downloads={[]} watches={[]} hints={[]} loading={false} />)
    const act = await screen.findByRole('button', { name: /^today\.needFtpAct/ })
    fireEvent.click(act)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText('servers.migrate.title')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    fireEvent.click(screen.getByRole('button', { name: /^today\.hide/ }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^today\.needFtpAct/ })).toBeNull())
    expect(localStorage.getItem('weebsync.today.hidden')).toBeNull()
    expect(sessionStorage.getItem('weebsync.today.hidden')).toContain('ftp-4')
  })
})

describe('the migration dialog', () => {
  it('keeps port 21 as explicit TLS, tests, then reports success', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ status: 'ok' } as never)
    wrap(<FtpsMigrateDialog server={srv()} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'servers.migrate.go' }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/servers/4/migrate-ftps', { port: 21, force: false }))
    expect(await screen.findByText('servers.migrate.done:21')).toBeTruthy()
  })

  it('preselects implicit TLS for a server that used port 990', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ status: 'ok' } as never)
    wrap(<FtpsMigrateDialog server={srv({ port: 990 })} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'servers.migrate.go' }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/servers/4/migrate-ftps', { port: 990, force: false }))
  })

  it('says why a test failed and offers to save anyway, cancel or open the settings', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockRejectedValueOnce(
        new ApiError(502, 'x509: certificate signed by unknown authority', { code: 'cert_untrusted' }),
      )
      .mockResolvedValueOnce({ status: 'ok' } as never)
    const closed = vi.fn()
    wrap(<FtpsMigrateDialog server={srv()} onClose={closed} />)
    fireEvent.click(screen.getByRole('button', { name: 'servers.migrate.go' }))
    expect(await screen.findByText('servers.migrate.errCert')).toBeTruthy()
    expect(screen.getByText('servers.migrate.trySftp')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'servers.migrate.saveAnyway' }))
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/api/servers/4/migrate-ftps', { port: 21, force: true }))
    expect(await screen.findByText('servers.migrate.done:21')).toBeTruthy()
  })

  it('names a rejected login and does not push SFTP for it', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(502, '530 Login incorrect', { code: 'auth_failed' }))
    wrap(<FtpsMigrateDialog server={srv()} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'servers.migrate.go' }))
    expect(await screen.findByText('servers.migrate.errAuth')).toBeTruthy()
    expect(screen.queryByText('servers.migrate.trySftp')).toBeNull()
  })

  it('leads to the server settings and closes', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(502, 'AUTH TLS refused', { code: 'tls_unsupported' }))
    const closed = vi.fn()
    wrap(<FtpsMigrateDialog server={srv()} onClose={closed} />)
    fireEvent.click(screen.getByRole('button', { name: 'servers.migrate.go' }))
    expect(await screen.findByText('servers.migrate.errTls')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'servers.migrate.settings' }))
    expect(closed).toHaveBeenCalled()
    expect(screen.getByTestId('where').textContent).toBe('/settings/servers')
  })
})
