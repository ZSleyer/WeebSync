import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
const infoFor = vi.hoisted(() => ({ fail: false }))

vi.mock('hls.js', () => ({ default: { isSupported: () => false } }))
vi.mock('jassub', () => ({ default: function () {} }))
vi.mock('../pages/jassubWorker?worker&url', () => ({ default: 'worker.js' }))
vi.mock('../components/useImmersive', () => ({ useImmersive: () => {} }))
vi.mock('../components/toast', () => ({ useToast: () => () => {} }))
vi.mock('../api', async (orig) => {
  const real = await orig<typeof import('../api')>()
  return {
    ...real,
    api: {
      ...real.api,
      get: vi.fn(async (url: string) => {
        calls.push(url)
        if (url.startsWith('/api/play/info')) {
          if (infoFor.fail) throw new Error('boom')
          return {
            duration: 1400,
            container: 'mp4',
            video: { codec: 'h264', width: 1920, height: 1080 },
            audio: [{ index: 1, codec: 'aac', lang: 'jpn', default: true }],
            subs: [],
            chapters: [],
          }
        }
        if (url.startsWith('/api/browse/local')) {
          return ['ep1.mp4', 'ep2.mp4'].map((name) => ({ name, path: `/a/${name}`, isDir: false }))
        }
        return []
      }),
    },
  }
})

import Player from '../pages/Player'
import { SeriesModalProvider } from '../components/SeriesModal'

function Where() {
  const l = useLocation()
  return <output data-testid="where">{l.search}</output>
}

function mount(client = new QueryClient({ defaultOptions: { queries: { staleTime: 0 } } })) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/play?server=0&path=%2Fa%2Fep1.mp4']}>
        <SeriesModalProvider>
          <Player />
        </SeriesModalProvider>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', function () {
    return { observe() {}, disconnect() {}, unobserve() {} }
  })
  calls.length = 0
  infoFor.fail = false
  Object.defineProperty(HTMLMediaElement.prototype, 'load', { value: () => {}, configurable: true })
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: () => Promise.resolve(), configurable: true })
})

describe('Player page', () => {
  const infoCalls = () => calls.filter((c) => c.startsWith('/api/play/info')).length

  it('F01a-1: a window refocus does not refetch play-info', async () => {
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('video')).toBeTruthy())
    expect(infoCalls()).toBe(1)
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    expect(infoCalls()).toBe(1)
  })

  it('F01a-1: a failed refetch leaves the running player in place', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 0 } } })
    const { container } = mount(client)
    await waitFor(() => expect(container.querySelector('video')).toBeTruthy())
    const video = container.querySelector('video')
    infoFor.fail = true
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['play-info'] })
    })
    expect(infoCalls()).toBe(2)
    expect(client.getQueryState(['play-info', 0, '/a/ep1.mp4'])?.status).toBe('error')
    expect(container.querySelector('video')).toBe(video)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('F01a-1: a mount still refetches a stale cached answer', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 0 } } })
    client.setQueryData(['play-info', 0, '/a/ep1.mp4'], {
      duration: 1400,
      container: 'mp4',
      video: { codec: 'h264', width: 1920, height: 1080 },
      audio: [{ index: 1, codec: 'aac', lang: 'jpn', default: true }],
      subs: [],
      chapters: [],
      anilist: { mediaId: 1, episode: 2, progress: 0 },
    })
    mount(client)
    await waitFor(() => expect(infoCalls()).toBe(1))
  })

  it('F01a-5: the announcement region is in the page before its text is', async () => {
    localStorage.setItem('weebsync.player.pos', JSON.stringify({ '0:/a/ep1.mp4': { at: 300, t: 1 } }))
    const { container } = mount()
    const seen: { target: Node; text: boolean }[] = []
    const mo = new MutationObserver((rs) => {
      for (const r of rs) seen.push({ target: r.target, text: [...r.addedNodes].some((n) => n.nodeType === 3) })
    })
    mo.observe(container, { childList: true, subtree: true })
    await screen.findByRole('button', { name: 'Resume' })
    await act(async () => {})
    mo.disconnect()
    const region = [...container.querySelectorAll('.sr-only[role="status"]')].find((r) =>
      /5:00/.test(r.textContent ?? ''),
    )!
    expect(region).toBeTruthy()
    // the text was put into a region that already stood, not added with it
    expect(seen.some((m) => m.target === region && m.text)).toBe(true)
  })

  // media-chrome 4.19.3 acts on j, l and c itself at keyup (media-controller.js,
  // ButtonPressedKeys + keyboardShortcutHandler) unless the controller's
  // `hotkeys` attribute holds `no<key>` for it (same file, keyboardShortcutHandler).
  // Its elements do not upgrade under jsdom (server-safe-globals.js treats the
  // node-like env as a server), so the contract is checked on the attribute
  // while the player's own handler is exercised for real.
  it("F01a-2: j, l and c are the player's alone: media-chrome is told to stay out, the player seeks once", async () => {
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('video')).toBeTruthy())
    const ctl = container.querySelector('media-controller')!
    const video = container.querySelector('video')!
    Object.defineProperty(video, 'duration', { value: 1400, configurable: true })
    const tokens = (ctl.getAttribute('hotkeys') ?? '').split(/\s+/)
    for (const key of ['j', 'l', 'c']) expect(tokens).toContain(`no${key}`)
    // the keys media-chrome keeps are not switched off
    for (const key of ['f', 'm', 'k', 'space', 'arrowleft', 'arrowright']) expect(tokens).not.toContain(`no${key}`)
    video.currentTime = 100
    fireEvent.keyDown(video, { key: 'j' })
    expect(video.currentTime).toBe(90)
    fireEvent.keyDown(video, { key: 'l' })
    expect(video.currentTime).toBe(100)
  })

  // media-chrome gives the media element tabindex -1 (media-controller.js:422)
  // so that focus can return to it; jsdom does not upgrade the controller
  const focusable = (video: HTMLVideoElement) => {
    video.tabIndex = -1
    return video
  }

  it('F01a-4: answering the resume card from the keyboard leaves the focus in the player', async () => {
    localStorage.setItem('weebsync.player.pos', JSON.stringify({ '0:/a/ep1.mp4': { at: 300, t: 1 } }))
    const { container } = mount()
    const go = await screen.findByRole('button', { name: 'Resume' })
    const video = focusable(container.querySelector('video')!)
    go.focus()
    fireEvent.click(go)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull())
    expect(video).toHaveFocus()
  })

  it('F01a-4: the unmute pill hands the focus back to the player', async () => {
    const { container } = mount()
    const video = await waitFor(() => {
      const v = container.querySelector('video')
      expect(v).toBeTruthy()
      return focusable(v!)
    })
    video.play = () => Promise.reject(new DOMException('no', 'NotAllowedError'))
    // the source effect waits for the device's codec answer: ask until it listens
    const pill = await waitFor(async () => {
      await act(async () => {
        video.dispatchEvent(new Event('loadedmetadata'))
      })
      return screen.getByRole('button', { name: 'Sound on' })
    })
    pill.focus()
    fireEvent.click(pill)
    await act(async () => {
      video.dispatchEvent(new Event('volumechange'))
    })
    expect(screen.queryByRole('button', { name: 'Sound on' })).toBeNull()
    expect(video).toHaveFocus()
  })

  it('F01a-5: the resume offer is announced and waits while the focus is on it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      localStorage.setItem('weebsync.player.pos', JSON.stringify({ '0:/a/ep1.mp4': { at: 300, t: 1 } }))
      mount()
      const go = await screen.findByRole('button', { name: 'Resume' })
      // a live region that was there before its text: the one the skip card uses
      expect(
        screen.getAllByRole('status').some((r) => r.classList.contains('sr-only') && /5:00/.test(r.textContent ?? '')),
      ).toBe(true)
      act(() => go.focus())
      await act(async () => {
        vi.advanceTimersByTime(40_000)
      })
      expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
      act(() => go.blur())
      await act(async () => {
        vi.advanceTimersByTime(16_000)
      })
      expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  const spoken = (container: HTMLElement) =>
    [...container.querySelectorAll('[role="status"],[role="alert"]')].map((el) => {
      const copy = el.cloneNode(true) as HTMLElement
      copy.querySelectorAll('[aria-hidden="true"]').forEach((h) => h.remove())
      return copy.textContent
    })

  it('F01a-6: a wait that counts up is not read out again every second', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { container } = mount()
      await waitFor(() => expect(container.querySelector('.t-player-step')).toBeTruthy())
      const before = spoken(container)
      expect(before.join('')).not.toBe('')
      for (let i = 0; i < 12; i++)
        await act(async () => {
          vi.advanceTimersByTime(1000)
        })
      // the count is on screen, but outside what a screen reader announces
      expect(container.querySelector('.t-player-step')?.textContent).toMatch(/\d+ s/)
      expect(spoken(container)).toEqual(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('F01a-6: the next-episode countdown is announced once, not per second', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { container } = mount()
      const video = await waitFor(() => {
        const v = container.querySelector('video')
        expect(v).toBeTruthy()
        return v!
      })
      // the folder listing decides whether there is a next episode
      await waitFor(() => expect(calls.some((c) => c.startsWith('/api/browse/local'))).toBe(true))
      await act(async () => {
        await Promise.resolve()
      })
      await waitFor(async () => {
        await act(async () => {
          video.dispatchEvent(new Event('ended'))
        })
        expect(screen.getByRole('button', { name: 'Now' })).toBeTruthy()
      })
      const first = spoken(container)
      expect(first.some((x) => /8 s/.test(x ?? ''))).toBe(true)
      for (let i = 0; i < 3; i++)
        await act(async () => {
          vi.advanceTimersByTime(1000)
        })
      expect(screen.getByText(/Next episode in [4-7] s/)).toBeTruthy()
      expect(spoken(container)).toEqual(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['play', 'seeking'])('F01a-7: %s during the next-episode countdown calls it off', async (event) => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { container } = mount()
      const video = await waitFor(() => {
        const v = container.querySelector('video')
        expect(v).toBeTruthy()
        return v!
      })
      await waitFor(async () => {
        await act(async () => {
          video.dispatchEvent(new Event('ended'))
        })
        expect(screen.getByRole('button', { name: 'Now' })).toBeTruthy()
      })
      await act(async () => {
        video.dispatchEvent(new Event(event))
      })
      expect(screen.queryByRole('button', { name: 'Now' })).toBeNull()
      for (let i = 0; i < 12; i++)
        await act(async () => {
          vi.advanceTimersByTime(1000)
        })
      expect(screen.getByTestId('where').textContent).toContain('ep1.mp4')
    } finally {
      vi.useRealTimers()
    }
  })

  // the list scrolls to the playing episode by where the row is drawn, not by
  // offsetTop (which counts from the nearest positioned ancestor, not the list)
  it('F01a-8: the episode list centres the playing episode in the list itself', async () => {
    const set: number[] = []
    Object.defineProperty(HTMLOListElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => 50,
      set: (v: number) => void set.push(v),
    })
    Object.defineProperty(HTMLOListElement.prototype, 'clientHeight', { configurable: true, get: () => 300 })
    const rect = (top: number, height: number) => ({ top, height, bottom: top + height }) as DOMRect
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.tagName === 'OL') return rect(200, 300)
      if (this.getAttribute('aria-current') === 'true') return rect(700, 40)
      return rect(0, 0)
    })
    try {
      const { container } = mount()
      await waitFor(() => expect(container.querySelector('ol [aria-current="true"]')).toBeTruthy())
      // row 500 px under the list's top edge, the list already scrolled by 50
      await waitFor(() => expect(set.at(-1)).toBe(500 + 50 - 150 + 20))
    } finally {
      spy.mockRestore()
      delete (HTMLOListElement.prototype as unknown as Record<string, unknown>).scrollTop
      delete (HTMLOListElement.prototype as unknown as Record<string, unknown>).clientHeight
    }
  })

  describe('F01a-3: switching episodes', () => {
    const switchToNext = async () => {
      const view = mount()
      const video = await waitFor(() => {
        const v = view.container.querySelector('video')
        expect(v).toBeTruthy()
        return focusable(v!)
      })
      await waitFor(() => expect(calls.some((c) => c.startsWith('/api/browse/local'))).toBe(true))
      const page = view.container.querySelector('.t-player-page')!
      const controller = view.container.querySelector('media-controller')!
      video.focus()
      // the folder listing decides whether there is a next episode
      await waitFor(async () => {
        await act(async () => {
          fireEvent.keyDown(video, { key: 'N', shiftKey: true })
        })
        expect(screen.getByTestId('where').textContent).toContain('ep2.mp4')
      })
      return { view, page, controller }
    }

    it('keeps the element that goes fullscreen, so the browser has nothing to leave', async () => {
      const { view, page, controller } = await switchToNext()
      await waitFor(() => expect(view.container.querySelector('video')).toBeTruthy())
      expect(view.container.querySelector('.t-player-page')).toBe(page)
      // the controller of the new file goes fullscreen through that same element
      const next = view.container.querySelector('media-controller') as HTMLElement & { fullscreenElement?: Element }
      expect(next).not.toBe(controller)
      expect(next.fullscreenElement).toBe(page)
    })

    it('puts the focus back into the player when it was in it', async () => {
      const { view } = await switchToNext()
      const video = await waitFor(() => {
        const v = view.container.querySelector('video')
        expect(v).toBeTruthy()
        return v!
      })
      video.tabIndex = -1
      // the new player's video is focusable once media-chrome has it (jsdom: by hand)
      await waitFor(() => expect(video).toHaveFocus())
    })
  })

  // media-chrome shows a control's tooltip while it matches :hover or
  // :focus-visible (media-chrome-button.js 4.19.3); a phone keeps :hover on
  // the last button tapped, so its tooltip stayed. player.css hides the
  // tooltips while the player carries data-notips; jsdom cannot match
  // ::part, so the tests follow the attribute.
  describe('control tooltips', () => {
    const pointer = (type: string, pointerType: string) =>
      Object.assign(new Event(type, { bubbles: true }), { pointerType })
    const setup = async () => {
      const { container } = mount()
      await waitFor(() => expect(container.querySelector('video')).toBeTruthy())
      const player = container.querySelector('media-controller')!
      const button = player.querySelector('media-fullscreen-button') ?? player
      return { player, button }
    }

    it('stay away after a tap or a pen, so none lingers on the last button tapped', async () => {
      const { player, button } = await setup()
      expect(player.hasAttribute('data-notips')).toBe(false)
      await act(async () => {
        button.dispatchEvent(pointer('pointerdown', 'touch'))
        fireEvent.click(button)
      })
      expect(player.hasAttribute('data-notips')).toBe(true)
      // a touch moving over the controls does not bring them back
      button.dispatchEvent(pointer('pointerover', 'touch'))
      expect(player.hasAttribute('data-notips')).toBe(true)
      fireEvent.keyDown(player, { key: 'Tab' })
      button.dispatchEvent(pointer('pointerdown', 'pen'))
      expect(player.hasAttribute('data-notips')).toBe(true)
    })

    it('come back for the keyboard and for a mouse', async () => {
      const { player, button } = await setup()
      button.dispatchEvent(pointer('pointerdown', 'touch'))
      fireEvent.keyDown(player, { key: 'Tab' })
      expect(player.hasAttribute('data-notips')).toBe(false)
      button.dispatchEvent(pointer('pointerdown', 'touch'))
      button.dispatchEvent(pointer('pointerover', 'mouse'))
      expect(player.hasAttribute('data-notips')).toBe(false)
    })

    it('are dismissed with Escape until the pointer or the focus moves on (WCAG 1.4.13)', async () => {
      const { player, button } = await setup()
      // with no menu open Escape leaves the player; with one open while the
      // focus is on the bar it only closes the tooltip
      player.querySelector('media-settings-menu')!.removeAttribute('hidden')
      fireEvent.keyDown(player, { key: 'Escape' })
      expect(player.hasAttribute('data-notips')).toBe(true)
      button.dispatchEvent(pointer('pointerover', 'mouse'))
      expect(player.hasAttribute('data-notips')).toBe(false)
      fireEvent.keyDown(player, { key: 'Escape' })
      fireEvent.keyDown(player, { key: 'Tab' })
      expect(player.hasAttribute('data-notips')).toBe(false)
    })
  })
})
