import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PromptModal from '../components/PromptModal'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

const dialogOf = (c: HTMLElement) => c.querySelector('dialog') as HTMLDialogElement

describe('PromptModal', () => {
  it('submits the typed value through the form', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(<PromptModal title="Umbenennen" defaultValue="alt" onSubmit={onSubmit} onCancel={onCancel} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'neu' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('neu'))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancels on the cancel button', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(<PromptModal title="Umbenennen" onSubmit={onSubmit} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('cancels on Escape, even with the field focused (the Firefox path)', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const { container } = render(<PromptModal title="Umbenennen" onSubmit={onSubmit} onCancel={onCancel} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(dialogOf(container).open).toBe(false)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
