import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PathCrumbs } from '../components/FileBrowser'
import { api } from '../api'

function crumbs(after?: ReactNode) {
  vi.spyOn(api, 'get').mockResolvedValue([])
  const onNavigate = vi.fn()
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <PathCrumbs
        path="Show/Season 01"
        onNavigate={onNavigate}
        fetchPath={(p) => p}
        queryKey={['local']}
        after={after}
      />
    </QueryClientProvider>,
  )
  return { onNavigate, row: view.container.querySelector('.ws-crumbs-row') as HTMLElement }
}

const editor = () => screen.queryByRole('combobox', { name: 'remote.editPath' })

afterEach(() => vi.restoreAllMocks())

describe('PathCrumbs', () => {
  it('opens the path editor from the empty space of the row', () => {
    const { row } = crumbs()
    expect(editor()).toBeNull()
    fireEvent.click(row)
    expect(editor()).toHaveValue('Show/Season 01')
  })

  it('opens it from the empty part of the crumbs too', () => {
    crumbs()
    const nav = screen.getByRole('navigation')
    fireEvent.pointerDown(nav)
    fireEvent.click(nav)
    expect(editor()).toHaveValue('Show/Season 01')
  })

  it('does not open it after a press that began on a crumb', () => {
    const { onNavigate } = crumbs()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Show' }))
    fireEvent.click(screen.getByRole('navigation'))
    expect(editor()).toBeNull()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('does not open it over a text selection', () => {
    const { row } = crumbs()
    const range = document.createRange()
    range.selectNodeContents(screen.getByRole('button', { name: 'Show' }))
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    fireEvent.pointerDown(row)
    fireEvent.click(row)
    expect(editor()).toBeNull()
    window.getSelection()?.removeAllRanges()
  })

  it('navigates from a parent crumb instead', () => {
    const { onNavigate } = crumbs()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(onNavigate).toHaveBeenCalledWith('Show')
    expect(editor()).toBeNull()
  })

  it('keeps the slot out of the row click', () => {
    const onSlot = vi.fn()
    crumbs(<button onClick={onSlot}>mark</button>)
    fireEvent.click(screen.getByRole('button', { name: 'mark' }))
    expect(onSlot).toHaveBeenCalled()
    expect(editor()).toBeNull()
  })

  it('offers no editing where it is off', () => {
    const { container } = render(<PathCrumbs path="a" onNavigate={() => {}} />)
    const row = container.querySelector('.ws-crumbs-row')!
    expect(row).not.toHaveClass('ws-crumbs-row--edit')
    expect(screen.queryByRole('button', { name: 'remote.editPath' })).toBeNull()
    fireEvent.pointerDown(row)
    fireEvent.click(row)
    expect(container.querySelector('input')).toBeNull()
  })
})
