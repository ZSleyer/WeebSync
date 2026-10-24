import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Setup from '../pages/Setup'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

const renderSetup = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Setup />
    </QueryClientProvider>,
  )

describe('Setup wizard', () => {
  it('has one h1, the step as h2 and the optional steps marked in the rail', () => {
    vi.spyOn(api, 'get').mockResolvedValue({})
    renderSetup()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('setup.accountTitle')
    expect(screen.getAllByText('setup.optional')).toHaveLength(2)
  })

  it('drops the local account fields for SSO only, and goes on without registering', () => {
    vi.spyOn(api, 'get').mockResolvedValue({})
    const post = vi.spyOn(api, 'post')
    renderSetup()
    expect(screen.getByLabelText('login.email')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.queryByLabelText('login.email')).toBeNull()
    // the code from the server log is asked for on either path
    fireEvent.change(screen.getByLabelText('setup.token'), { target: { value: 'abcd-efgh' } })
    fireEvent.click(screen.getByRole('button', { name: 'setup.continue' }))
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('setup.oidcTitle')
    // back from the required provider step returns to the account
    fireEvent.click(screen.getByRole('button', { name: 'setup.back' }))
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('setup.accountTitle')
  })

  it('moves focus to the heading when the OIDC step turns into the ready screen', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({})
    vi.spyOn(api, 'post').mockResolvedValue({ oidcEnabled: true })
    renderSetup()
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.change(screen.getByLabelText('setup.token'), { target: { value: 'abcd-efgh' } })
    fireEvent.click(screen.getByRole('button', { name: 'setup.continue' }))
    const form = screen.getByRole('heading', { level: 2 }).closest('form')!
    await act(async () => fireEvent.submit(form))
    await waitFor(() => expect(screen.getByText('setup.oidcReady')).toBeTruthy())
    // the submit button that had the focus is gone: the heading takes it
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }))
  })

  it('still renders and steps on when the browser blocks site storage', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({})
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked)
    const done = vi.fn()
    // a resumed run: the stored step is read while the first render builds its state
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Setup initialStep="import" onDone={done} />
      </QueryClientProvider>,
    )
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('setup.importTitle')
    // skipping to the next step writes the step again
    fireEvent.click(screen.getByRole('button', { name: 'setup.skip' }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 }).textContent).not.toBe('setup.importTitle'))
  })
})
