import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import LegacyImport, { type LegacyPlan } from '../components/LegacyImport'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

const plan: LegacyPlan = {
  server: {
    name: 'old',
    protocol: 'ftp',
    host: 'h.example.com',
    port: 22,
    username: 'u',
    oldPort: 21,
    hasPassword: false,
  },
  watches: [],
  intervalMin: 5,
}

vi.mock(import('../api'), async (importOriginal) => ({
  ...(await importOriginal()),
  api: { get: vi.fn(async () => []), post: vi.fn(async () => plan) } as never,
}))

async function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={qc}>
      <LegacyImport />
    </QueryClientProvider>,
  )
  const file = new File(['{"server":{}}'], 'config.json', { type: 'application/json' })
  fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } })
  await waitFor(() => expect(container.querySelector('input[name=port]')).not.toBeNull())
  return container
}

describe('LegacyImport port', () => {
  it('follows the protocol until the user edits it', async () => {
    const c = await open()
    const port = c.querySelector<HTMLInputElement>('input[name=port]')!
    const pick = (label: RegExp) => {
      fireEvent.click(screen.getAllByRole('combobox').find((b) => /SFTP|FTPS/.test(b.textContent ?? ''))!)
      fireEvent.click(screen.getByRole('option', { name: label, hidden: true }))
    }
    expect(port.value).toBe('22')
    expect(screen.queryByText('servers.tlsHint')).toBeNull()
    pick(/FTPS/)
    expect(port.value).toBe('21')
    expect(screen.getByText('servers.tlsHint')).toBeTruthy()
    pick(/SFTP/)
    expect(port.value).toBe('22')
    fireEvent.change(port, { target: { value: '2222' } })
    pick(/FTPS/)
    expect(port.value).toBe('2222')
  })
})
