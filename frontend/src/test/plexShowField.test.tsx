import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PlexShowField, { type PlexShowState } from '../components/PlexShowField'
import { api } from '../api'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const state: PlexShowState = {
  show: { ratingKey: '62755', title: 'Re:ZERO', year: 2016, library: 'Animeserien' },
  source: 'series',
  candidates: [
    { ratingKey: '62755', title: 'Re:ZERO', year: 2016, library: 'Animeserien' },
    { ratingKey: '71812', title: 'Das Band der Unterwelt', year: 2026, library: 'Animeserien' },
  ],
}

function open(onDone = vi.fn()) {
  render(<PlexShowField watchId={1} state={state} onDone={onDone} />)
  return { onDone, input: screen.getByRole('combobox') }
}

describe('PlexShowField', () => {
  it('shows the bound show in the field', () => {
    const { input } = open()
    expect(input).toHaveValue('Re:ZERO')
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('binds the show picked with the keyboard', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    const { onDone, input } = open()

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const second = screen.getByRole('option', { name: /Das Band der Unterwelt/ })
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', second.id)
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/watches/1/plex-show', { ratingKey: '71812' }))
    expect(onDone).toHaveBeenCalled()
    put.mockRestore()
  })

  it('closes the list on Escape without letting the key reach the dialog', () => {
    const outer = vi.fn()
    render(
      <div onKeyDown={outer}>
        <PlexShowField watchId={1} state={state} onDone={vi.fn()} />
      </div>,
    )
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(outer).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }))
  })

  it('binds the show picked with the mouse', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    const { input } = open()
    fireEvent.click(input)
    fireEvent.mouseDown(screen.getByRole('option', { name: /Das Band der Unterwelt/ }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/watches/1/plex-show', { ratingKey: '71812' }))
    put.mockRestore()
  })

  it('sends an empty key to hand the series back to the automatic routes', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    open()

    fireEvent.click(screen.getByText('watch.plexShowClear'))
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/watches/1/plex-show', { ratingKey: '' }))
    put.mockRestore()
  })

  it('filters the library by what is typed', () => {
    const { input } = open()
    fireEvent.change(input, { target: { value: 'unterwelt' } })

    expect(screen.getByRole('option', { name: /Das Band der Unterwelt/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Re:ZERO/ })).toBeNull()
  })

  it('reports a refused binding', async () => {
    const put = vi.spyOn(api, 'put').mockRejectedValue(new Error('already bound'))
    const { onDone, input } = open()

    fireEvent.click(input)
    fireEvent.mouseDown(screen.getByRole('option', { name: /Re:ZERO/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already bound')
    expect(onDone).not.toHaveBeenCalled()
    put.mockRestore()
  })
})
