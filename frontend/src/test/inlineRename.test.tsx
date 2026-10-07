import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InlineRename } from '../components/InlineRename'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

describe('InlineRename', () => {
  it('saves on Enter, abandons on Escape, and selects the name without its extension', () => {
    const done = vi.fn()
    const { unmount } = render(<InlineRename name="Frieren S02E07.mkv" onDone={done} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.selectionEnd).toBe('Frieren S02E07'.length)
    fireEvent.change(input, { target: { value: 'Frieren S02E08.mkv' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(done).toHaveBeenLastCalledWith('Frieren S02E08.mkv')
    unmount()
    const abandon = vi.fn()
    render(<InlineRename name="a.mkv" onDone={abandon} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(abandon).toHaveBeenLastCalledWith(null)
  })
})
