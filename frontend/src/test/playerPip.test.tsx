import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
        if (url.startsWith('/api/play/info')) {
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

const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0'
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 15; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0'
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
const realUA = navigator.userAgent

// The Player reads the user agent once, when its module is evaluated: each
// case loads it afresh under the agent it names.
async function mount(ua = realUA) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
  vi.resetModules()
  const [{ default: Player }, { SeriesModalProvider }, { QueryClient, QueryClientProvider }, { MemoryRouter }] =
    await Promise.all([
      import('../pages/Player'),
      import('../components/SeriesModal'),
      import('@tanstack/react-query'),
      import('react-router'),
    ])
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/play?server=0&path=%2Fa%2Fep1.mp4']}>
        <SeriesModalProvider>
          <Player />
        </SeriesModalProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await waitFor(() => expect(view.container.querySelector('video')).toBeTruthy())
  return { ...view, video: view.container.querySelector('video')! }
}

let pipElement: Element | null = null
const float = (v: HTMLVideoElement) => {
  pipElement = v
  v.dispatchEvent(new Event('enterpictureinpicture'))
}
const request = vi.fn(async function (this: HTMLVideoElement) {
  if (this.disablePictureInPicture) throw new DOMException('disabled', 'InvalidStateError')
  float(this)
  return {} as PictureInPictureWindow
})

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', function () {
    return { observe() {}, disconnect() {}, unobserve() {} }
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  pipElement = null
  request.mockClear()
  Object.defineProperty(HTMLMediaElement.prototype, 'load', { value: () => {}, configurable: true })
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: () => Promise.resolve(), configurable: true })
  // jsdom's track lists are no event targets, media-chrome listens on them
  for (const name of ['textTracks', 'audioTracks', 'videoTracks']) {
    const lists = new WeakMap<object, EventTarget>()
    Object.defineProperty(HTMLMediaElement.prototype, name, {
      get() {
        if (!lists.has(this)) lists.set(this, Object.assign(new EventTarget(), { length: 0, *[Symbol.iterator]() {} }))
        return lists.get(this)
      },
      configurable: true,
    })
  }
  // nor has jsdom Element.part, which a media-chrome item marks as checked
  if (!('part' in HTMLElement.prototype)) {
    const parts = new WeakMap<object, DOMTokenList>()
    Object.defineProperty(HTMLElement.prototype, 'part', {
      get() {
        if (!parts.has(this)) parts.set(this, document.createElement('i').classList)
        return parts.get(this)
      },
      configurable: true,
    })
  }
  // jsdom knows no picture in picture: the API as Chrome has it
  Object.defineProperty(HTMLVideoElement.prototype, 'disablePictureInPicture', {
    get() {
      return this.hasAttribute('disablepictureinpicture')
    },
    set(v: boolean) {
      this.toggleAttribute('disablepictureinpicture', !!v)
    },
    configurable: true,
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { value: request, configurable: true })
  Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true })
  Object.defineProperty(document, 'pictureInPictureElement', { get: () => pipElement, configurable: true })
  Object.defineProperty(document, 'exitPictureInPicture', {
    value: async () => {
      const v = pipElement
      pipElement = null
      v?.dispatchEvent(new Event('leavepictureinpicture'))
    },
    configurable: true,
  })
})

afterEach(() => {
  Object.defineProperty(navigator, 'userAgent', { value: realUA, configurable: true })
})

describe('the native picture in picture of the browser', () => {
  it.each([
    ['Chrome on Android', CHROME_ANDROID],
    ['Safari on an iPhone', SAFARI_IOS],
    ['Firefox on Android', FIREFOX_ANDROID],
  ])('stays allowed in %s, so fullscreen and Home (or its gestures) float the video', async (_, ua) => {
    const { video } = await mount(ua)
    expect(video.hasAttribute('disablepictureinpicture')).toBe(false)
  })

  it('asks WebKit to float the video by itself (autopictureinpicture)', async () => {
    const { video } = await mount(SAFARI_IOS)
    expect(video.getAttribute('autopictureinpicture')).toBe('')
  })

  it('stays allowed after the own window closed again', async () => {
    const { video, getByRole } = await mount(CHROME_ANDROID)
    const button = getByRole('button', { name: 'Picture in picture' })
    await act(async () => button.click())
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => document.exitPictureInPicture())
    expect(video.hasAttribute('disablepictureinpicture')).toBe(false)
  })

  it('is switched off in desktop Firefox, whose overlay toggle sits on the picture, and lifted while ours asks', async () => {
    const { video, getByRole } = await mount(FIREFOX_LINUX)
    expect(video.hasAttribute('disablepictureinpicture')).toBe(true)
    await act(async () => getByRole('button', { name: 'Picture in picture' }).click())
    expect(request).toHaveBeenCalledTimes(1)
    expect(video.hasAttribute('disablepictureinpicture')).toBe(false)
    await act(async () => document.exitPictureInPicture())
    expect(video.hasAttribute('disablepictureinpicture')).toBe(true)
  })
})

// The real media-chrome menu does the picking: on a click, or on Enter and
// Space while the item has the focus, it flips the item and fires change
// only when the set of checked items changed (media-chrome-menu.js 4.19.3,
// handleSelect and selectItem).
async function choose(menu: Element, item: Element, how: 'click' | 'Enter' | ' ' = 'click') {
  expect(customElements.get('media-settings-menu')).toBeTruthy()
  menu.removeAttribute('hidden')
  await act(async () => {
    if (how === 'click') (item as HTMLElement).click()
    else {
      ;(item as HTMLElement).focus()
      item.dispatchEvent(new KeyboardEvent('keydown', { key: how, bubbles: true, composed: true }))
    }
  })
}

describe('picture in picture in the settings menu', () => {
  const find = (container: HTMLElement) => {
    const menu = container.querySelector('media-settings-menu')!
    const item = [...menu.querySelectorAll('media-chrome-menu-item')].find((i) =>
      /Picture in picture/.test(i.textContent ?? ''),
    )
    return { menu, item }
  }

  it('is a checkable item there on every width, so a phone reaches it', async () => {
    const { container } = await mount(CHROME_ANDROID)
    const { item } = find(container)
    expect(item).toBeTruthy()
    expect(item!.getAttribute('type')).toBe('checkbox')
    expect(item!.getAttribute('aria-checked')).toBe('false')
  })

  it('opens the window, shows it as checked, and closes it again', async () => {
    const { container, video } = await mount(CHROME_ANDROID)
    const { menu, item } = find(container)
    await choose(menu, item!)
    expect(request).toHaveBeenCalledTimes(1)
    expect(document.pictureInPictureElement).toBe(video)
    expect(item!.getAttribute('aria-checked')).toBe('true')
    await choose(menu, item!)
    expect(document.pictureInPictureElement).toBeNull()
    expect(item!.getAttribute('aria-checked')).toBe('false')
  })

  it.each([['Enter'], [' ']] as const)('answers %j on the focused item, both ways', async (key) => {
    const { container, video } = await mount(CHROME_ANDROID)
    const { menu, item } = find(container)
    await choose(menu, item!, key)
    expect(document.pictureInPictureElement).toBe(video)
    expect(item!.getAttribute('aria-checked')).toBe('true')
    await choose(menu, item!, key)
    expect(document.pictureInPictureElement).toBeNull()
    expect(item!.getAttribute('aria-checked')).toBe('false')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('stays unchecked when the browser refuses the window', async () => {
    const { container } = await mount(CHROME_ANDROID)
    const { menu, item } = find(container)
    request.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'))
    await choose(menu, item!)
    expect(request).toHaveBeenCalledTimes(1)
    expect(item!.getAttribute('aria-checked')).toBe('false')
  })

  it('leaves a pick in a submenu (speed) alone', async () => {
    const { container } = await mount(CHROME_ANDROID)
    const { menu } = find(container)
    const sub = menu.querySelector('media-chrome-menu[slot="submenu"]')!
    await act(async () => sub.dispatchEvent(new Event('change', { bubbles: true, composed: true })))
    expect(request).not.toHaveBeenCalled()
  })
})

describe('picture in picture when the tab is left', () => {
  type Handler = ((d: object) => void) | null
  const handlers = new Map<string, Handler>()
  const keep = (a: string, fn: Handler) => void handlers.set(a, fn)
  const session = {
    metadata: null as unknown,
    setActionHandler: vi.fn(keep),
    setPositionState: () => {},
  }
  beforeEach(() => {
    handlers.clear()
    session.metadata = null
    session.setActionHandler.mockReset()
    session.setActionHandler.mockImplementation(keep)
    Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true })
    vi.stubGlobal('MediaMetadata', function (this: object, m: object) {
      Object.assign(this, m)
    })
  })
  afterEach(() => {
    delete (navigator as { mediaSession?: unknown }).mediaSession
  })
  const playing = (v: HTMLVideoElement, on: boolean) =>
    Object.defineProperty(v, 'paused', { value: !on, configurable: true })
  const ask = () => handlers.get('enterpictureinpicture')!({ action: 'enterpictureinpicture' })

  it('floats the playing video when the browser asks, and only then', async () => {
    const { video } = await mount(CHROME_ANDROID)
    await waitFor(() => expect(handlers.get('enterpictureinpicture')).toBeTypeOf('function'))
    playing(video, false)
    await act(async () => ask())
    expect(request).not.toHaveBeenCalled()
    playing(video, true)
    await act(async () => ask())
    expect(request).toHaveBeenCalledTimes(1)
    expect(document.pictureInPictureElement).toBe(video)
  })

  it('lifts the Firefox block for the request as the button does', async () => {
    const { video } = await mount(FIREFOX_LINUX)
    await waitFor(() => expect(handlers.get('enterpictureinpicture')).toBeTypeOf('function'))
    playing(video, true)
    await act(async () => ask())
    expect(document.pictureInPictureElement).toBe(video)
  })

  it('is left out where the browser does not know the action, the others stay', async () => {
    session.setActionHandler.mockImplementation((a: string, fn: Handler) => {
      if (a === 'enterpictureinpicture') throw new TypeError('unknown action')
      keep(a, fn)
    })
    await mount(CHROME_ANDROID)
    await waitFor(() => expect(handlers.get('play')).toBeTypeOf('function'))
    expect(handlers.has('enterpictureinpicture')).toBe(false)
  })

  it('is cleared with the others when the player goes', async () => {
    const { unmount } = await mount(CHROME_ANDROID)
    await waitFor(() => expect(handlers.get('enterpictureinpicture')).toBeTypeOf('function'))
    unmount()
    expect(handlers.get('enterpictureinpicture')).toBeNull()
    expect(handlers.get('play')).toBeNull()
  })

  it('stays with the audio player once it took the session over', async () => {
    const { unmount } = await mount(CHROME_ANDROID)
    await waitFor(() => expect(handlers.get('enterpictureinpicture')).toBeTypeOf('function'))
    session.metadata = { title: 'a song' }
    const theirs = () => {}
    handlers.set('enterpictureinpicture', theirs)
    unmount()
    expect(handlers.get('enterpictureinpicture')).toBe(theirs)
  })
})
