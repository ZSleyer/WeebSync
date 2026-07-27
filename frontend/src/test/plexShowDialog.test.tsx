import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PlexShowDialog, { type PlexShowState } from '../components/PlexShowDialog'
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

function open(onDone = vi.fn(), onClose = vi.fn()) {
  render(<PlexShowDialog watchId={1} state={state} onDone={onDone} onClose={onClose} />)
  return { onDone, onClose }
}

describe('PlexShowDialog', () => {
  it('binds the picked show and closes', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    const { onDone, onClose } = open()

    fireEvent.click(screen.getByText('Das Band der Unterwelt'))
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/watches/1/plex-show', { ratingKey: '71812' }))
    expect(onDone).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
    put.mockRestore()
  })

  it('sends an empty key to hand the series back to the automatic routes', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    open()

    fireEvent.click(screen.getByText('watch.plexShowClear'))
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/watches/1/plex-show', { ratingKey: '' }))
    put.mockRestore()
  })

  it('filters the library by the search field', () => {
    open()
    fireEvent.change(screen.getByLabelText('watch.plexShowSearch'), { target: { value: 'unterwelt' } })

    expect(screen.getByText('Das Band der Unterwelt')).toBeInTheDocument()
    expect(screen.queryByText('Re:ZERO')).not.toBeInTheDocument()
  })

  it('reports a refused binding instead of closing', async () => {
    const put = vi.spyOn(api, 'put').mockRejectedValue(new Error('already bound'))
    const { onClose } = open()

    fireEvent.click(screen.getByText('Re:ZERO'))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('already bound')
    expect(onClose).not.toHaveBeenCalled()
    put.mockRestore()
  })
})
