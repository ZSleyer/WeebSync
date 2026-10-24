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

  it('keeps a half-typed name when the window loses focus', () => {
    const done = vi.fn()
    render(<InlineRename name="a.mkv" onDone={done} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Show S01E0' } })
    const has = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    fireEvent.blur(input) // alt-tab: the document is no longer focused
    expect(done).not.toHaveBeenCalled()
    has.mockRestore()
  })

  it.each(['button', 'a', 'input'])('abandons the edit when focus moves to a %s', (tag) => {
    const done = vi.fn()
    render(
      <>
        <InlineRename name="a.mkv" onDone={done} />
        {tag === 'a' ? <a href="#x">x</a> : tag === 'input' ? <input aria-label="other" /> : <button>x</button>}
      </>,
    )
    const input = screen.getByRole('textbox', { name: 'local.renameField' })
    fireEvent.change(input, { target: { value: 'Show S01E0' } })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const other = document.querySelector(tag === 'input' ? 'input[aria-label=other]' : tag) as HTMLElement
    fireEvent.blur(input, { relatedTarget: other })
    expect(done).toHaveBeenCalledTimes(1)
    expect(done).toHaveBeenCalledWith(null)
  })

  it('saves when the click lands on empty space', () => {
    const done = vi.fn()
    render(<InlineRename name="a.mkv" onDone={done} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Show S01E0' } })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    fireEvent.blur(input, { relatedTarget: null })
    expect(done).toHaveBeenCalledWith('Show S01E0')
  })
})
