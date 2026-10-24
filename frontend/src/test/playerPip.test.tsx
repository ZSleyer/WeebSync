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
const request = vi.fn(async function (this: HTMLVideoElement) {
  if (this.disablePictureInPicture) throw new DOMException('disabled', 'InvalidStateError')
  pipElement = this
  this.dispatchEvent(new Event('enterpictureinpicture'))
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
