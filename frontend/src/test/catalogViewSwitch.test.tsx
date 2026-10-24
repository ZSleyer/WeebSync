import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CatalogViewSwitch } from '../components/CatalogViewSwitch'

describe('CatalogViewSwitch', () => {
  it.each(['catalogOnce', 'catalogPersist'] as const)(
    'ignores a click on the already active catalog option (%s)',
    (value) => {
      const onChange = vi.fn()
      render(<CatalogViewSwitch value={value} onChange={onChange} />)
      fireEvent.click(screen.getByLabelText('remote.catalog'))
      expect(onChange).not.toHaveBeenCalled()
    },
  )

  it('ignores a click on the already active classic option', () => {
    const onChange = vi.fn()
    render(<CatalogViewSwitch value="classic" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('remote.classic'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('switches from catalog to classic and back', () => {
    const onChange = vi.fn()
    const { rerender } = render(<CatalogViewSwitch value="catalogPersist" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('remote.classic'))
    expect(onChange).toHaveBeenLastCalledWith('classic')
    rerender(<CatalogViewSwitch value="classic" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('remote.catalog'))
    expect(onChange).toHaveBeenLastCalledWith('catalogOnce')
  })
})
