import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SidePanel, Toast, ToastRegion } from 'fluid-lycoris'

describe('ToastRegion', () => {
  it('is a manual popover live region and is raised again per toast', () => {
    const show = vi.fn()
    const hide = vi.fn()
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>
    const had = 'showPopover' in proto
    proto.showPopover = show
    proto.hidePopover = hide
    try {
      const { rerender } = render(<ToastRegion raise={1} />)
      const region = screen.getByRole('status', { hidden: true })
      expect(region).toHaveAttribute('popover', 'manual')
      expect(region).toHaveAttribute('aria-live', 'polite')
      expect(show).toHaveBeenCalledTimes(1)
      rerender(<ToastRegion raise={1} />)
      expect(show).toHaveBeenCalledTimes(1)
      rerender(<ToastRegion raise={2} />)
      expect(show).toHaveBeenCalledTimes(2)
    } finally {
      if (!had) {
        delete proto.showPopover
        delete proto.hidePopover
      }
    }
  })
})

describe('Toast', () => {
  it('shows the line, one action and the running-out bar', () => {
    const undo = vi.fn()
    const { container } = render(
      <Toast message="Gelöscht" action={{ label: 'Rückgängig', onClick: undo }} duration={5000} />,
    )
    expect(screen.getByText('Gelöscht')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }))
    expect(undo).toHaveBeenCalled()
    expect((container.querySelector('.t-toast__time') as HTMLElement).style.animationDuration).toBe('5000ms')
  })
})

describe('SidePanel width', () => {
  it('writes its width on the root while mounted, so toasts stand clear', () => {
    const { unmount } = render(
      <SidePanel aria-label="Details" onRequestClose={() => {}}>
        x
      </SidePanel>,
    )
    expect(document.documentElement.style.getPropertyValue('--sidepanel-w')).toBe('0px')
    unmount()
    expect(document.documentElement.style.getPropertyValue('--sidepanel-w')).toBe('')
  })
})
