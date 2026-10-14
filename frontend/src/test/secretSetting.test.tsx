import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '../components/confirm'
import { SecretSetting } from '../pages/settings/ui'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

const field = (props: { stored: boolean; env?: boolean }, onRemove = vi.fn()) => {
  render(
    <ConfirmProvider>
      <SecretSetting label="TMDB" value="" onChange={() => {}} onRemove={onRemove} {...props} />
    </ConfirmProvider>,
  )
  return onRemove
}

describe('SecretSetting', () => {
  it('clears a stored secret only after the confirm', async () => {
    const onRemove = field({ stored: true })
    fireEvent.click(screen.getByRole('button', { name: 'settings.secretRemoveLabel' }))
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'settings.secretRemove' }))
    await vi.waitFor(() => expect(onRemove).toHaveBeenCalledOnce())
  })

  it('keeps the secret when the confirm is cancelled', async () => {
    const onRemove = field({ stored: true })
    fireEvent.click(screen.getByRole('button', { name: 'settings.secretRemoveLabel' }))
    fireEvent.click(await screen.findByRole('button', { name: 'common.cancel' }))
    await Promise.resolve()
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('offers no remove for a missing or env-forced secret', () => {
    field({ stored: false })
    field({ stored: true, env: true })
    expect(screen.queryByRole('button')).toBeNull()
  })
})
