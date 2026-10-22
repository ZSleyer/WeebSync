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

  it('does not edit where editing is off', () => {
    const { container } = render(<PathCrumbs path="a" onNavigate={() => {}} />)
    fireEvent.click(container.querySelector('.ws-crumbs-row')!)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
