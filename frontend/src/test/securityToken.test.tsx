import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfirmProvider } from '../components/confirm'
import { ApiTokenSection } from '../pages/settings/Security'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => vi.restoreAllMocks())

function setup(apiTokenSet: boolean) {
  vi.spyOn(api, 'get').mockResolvedValue({ apiTokenSet })
  const post = vi.spyOn(api, 'post').mockResolvedValue({ token: 'new-token' })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <ApiTokenSection />
      </ConfirmProvider>
    </QueryClientProvider>,
  )
  return post
}

describe('API token', () => {
  it('asks before regenerating a token that is set', async () => {
    const post = setup(true)
    const regenerate = await screen.findByRole('button', { name: 'settings.apiTokenRegenerate' })
    fireEvent.click(regenerate)
    expect(await screen.findByText('settings.apiTokenConfirmRegenerate')).toBeTruthy()
    expect(post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    await Promise.resolve()
    expect(post).not.toHaveBeenCalled()
    fireEvent.click(regenerate)
    fireEvent.click(await screen.findByRole('button', { name: 'common.confirm' }))
    await waitFor(() => expect(post).toHaveBeenCalledOnce())
  })

  it('generates the first token without a prompt', async () => {
    const post = setup(false)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.apiTokenGenerate' }))
    await waitFor(() => expect(post).toHaveBeenCalledOnce())
  })
})
