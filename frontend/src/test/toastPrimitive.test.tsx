import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { SidePanel, Toast, toastDuration, ToastRegion } from 'fluid-lycoris'

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

describe('toastDuration', () => {
  it('reads by words, at least 6s, 8s with an action, at most 10s', () => {
    expect(toastDuration('Gelöscht')).toBe(6000)
    expect(toastDuration('Gelöscht', true)).toBe(8000)
    // 1s + 300ms per word
    expect(toastDuration(Array(20).fill('Wort').join(' '))).toBe(7000)
    expect(toastDuration(Array(50).fill('Wort').join(' '))).toBe(10000)
  })
})

describe('Timed toast', () => {
  it('closes when its time is up, held while focused or hidden', () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn()
      const { container } = render(<Toast message="Kopiert" duration={6000} onClose={close} closeLabel="Schließen" />)
      const ring = container.querySelector('.t-toast__ring') as HTMLElement
      expect(ring.style.animationDuration).toBe('6000ms')
      const button = screen.getByRole('button', { name: 'Schließen' })
      act(() => vi.advanceTimersByTime(3000))
      fireEvent.focus(button)
      expect(container.querySelector('.t-toast')).toHaveAttribute('data-paused')
      act(() => vi.advanceTimersByTime(30_000))
      expect(close).not.toHaveBeenCalled()
      fireEvent.blur(button)
      act(() => vi.advanceTimersByTime(2900))
      expect(close).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(200))
      expect(close).toHaveBeenCalledOnce()
      fireEvent.click(button)
      expect(close).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
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
