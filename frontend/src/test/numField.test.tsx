import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NumEdit, NumField } from '../pages/settings/maintenance'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

const editors = [
  ['NumField', (onCommit: () => void) => <NumField id="n" label="Interval" value={30} onCommit={onCommit} />],
  ['NumEdit', (onCommit: () => void) => <NumEdit id="n" label="Interval" value={30} onCommit={onCommit} />],
] as const

describe.each(editors)('%s', (_name, view) => {
  const type = (text: string, onCommit = vi.fn()) => {
    render(view(onCommit))
    const input = document.getElementById('n') as HTMLInputElement
    fireEvent.change(input, { target: { value: text } })
    fireEvent.blur(input)
    return { input, onCommit }
  }

  it.each(['2,5', '-1', 'abc', '1.5', ''])('puts the stored value back for %j', (text) => {
    const { input, onCommit } = type(text)
    expect(onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe('30')
  })

  it('commits a whole number', () => {
    const { onCommit } = type('45')
    expect(onCommit).toHaveBeenCalledWith(45)
  })
})
