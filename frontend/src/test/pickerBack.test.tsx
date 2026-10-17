import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { Dialog } from 'fluid-lycoris'
import PickerBack, { pathAtDepth, stepsBelow } from '../components/PickerBack'

describe('stepsBelow / pathAtDepth', () => {
  it('counts the folders below the start', () => {
    expect(stepsBelow('Anime', 'Anime')).toBe(0)
    expect(stepsBelow('Anime', 'Anime/Show/Season 1')).toBe(2)
    expect(stepsBelow('', 'a/b')).toBe(2)
    // elsewhere is not below
    expect(stepsBelow('Anime/Show', 'Anime')).toBe(0)
    expect(stepsBelow('Anime/Show', 'Movies/Show/x')).toBe(0)
    expect(stepsBelow('/lib', '/lib/a')).toBe(1)
  })
  it('cuts a path back to a depth, keeping its spelling', () => {
    expect(pathAtDepth('Anime', 'Anime/Show/Season 1', 1)).toBe('Anime/Show')
    expect(pathAtDepth('Anime', 'Anime/Show/Season 1', 0)).toBe('Anime')
    expect(pathAtDepth('/lib', '/lib/a/b', 1)).toBe('/lib/a')
    expect(pathAtDepth('', 'a/b', 0)).toBe('')
  })
})

// A picker in a dialog: the "navigate" buttons stand for FileBrowser's folder
// rows and up control. jsdom's history keeps entries but back() does not
// traverse, so a pop is the state replaced by the entry below plus the event.
function Harness({ onClose, startAt = 'Anime' }: { onClose: () => void; startAt?: string }) {
  const [path, setPath] = useState(startAt)
  return (
    <Dialog onClose={onClose}>
      <output data-testid="path">{path}</output>
      <button onClick={() => setPath(`${path}/sub`)}>into</button>
      <button onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>up</button>
      <button onClick={() => setPath(startAt)}>root</button>
      <PickerBack path={path} onNavigate={setPath} />
    </Dialog>
  )
}

const marks = () => history.state?.wsDialog as string | undefined
const pathText = (c: HTMLElement) => c.querySelector('[data-testid=path]')?.textContent

afterEach(() => vi.restoreAllMocks())

describe('PickerBack inside a dialog', () => {
  it('holds one entry per folder below the start', async () => {
    const before = history.state?.idx ?? 0
    const { getByText } = render(<Harness onClose={() => {}} />)
    expect(history.state.idx).toBe(before + 1) // the dialog's own
    fireEvent.click(getByText('into'))
    fireEvent.click(getByText('into'))
    await waitFor(() => expect(history.state.idx).toBe(before + 3))
  })

  it('goes up a folder on back and keeps the dialog until the start folder', async () => {
    const onClose = vi.fn()
    const { getByText, container } = render(<Harness onClose={onClose} />)
    const dialogEntry = history.state
    fireEvent.click(getByText('into'))
    await waitFor(() => expect(history.state.idx).toBe(dialogEntry.idx + 1))
    const folder1 = history.state
    fireEvent.click(getByText('into'))
    await waitFor(() => expect(history.state.idx).toBe(dialogEntry.idx + 2))
    expect(pathText(container)).toBe('Anime/sub/sub')
    // back: the browser lands on the entry below the top one
    const pop = (to: unknown) => {
      history.replaceState(to, '')
      fireEvent.popState(window)
    }
    pop(folder1)
    await waitFor(() => expect(pathText(container)).toBe('Anime/sub'))
    expect(onClose).not.toHaveBeenCalled()
    pop(dialogEntry)
    await waitFor(() => expect(pathText(container)).toBe('Anime'))
    expect(onClose).not.toHaveBeenCalled()
    // at the start folder the next entry down is the page's: the dialog goes
    const { wsDialog: _gone, ...page } = dialogEntry
    pop(page)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('does not step up twice for two pops answered in one go', async () => {
    const { getByText, container } = render(<Harness onClose={() => {}} />)
    const dialogEntry = history.state
    fireEvent.click(getByText('into'))
    await waitFor(() => expect(history.state.idx).toBe(dialogEntry.idx + 1))
    const folder1 = history.state
    fireEvent.click(getByText('into'))
    await waitFor(() => expect(history.state.idx).toBe(dialogEntry.idx + 2))
    fireEvent.click(getByText('into'))
    await waitFor(() => expect(history.state.idx).toBe(dialogEntry.idx + 3))
    expect(pathText(container)).toBe('Anime/sub/sub/sub')
    // two entries popped by one swipe: the browser lands on the first folder's
    history.replaceState(folder1, '')
    fireEvent.popState(window)
    await waitFor(() => expect(pathText(container)).toBe('Anime/sub'))
  })

  it('takes every entry back in one step when the folder is left by the picker itself', async () => {
    const go = vi.spyOn(history, 'go').mockImplementation(() => {})
    const back = vi.spyOn(history, 'back').mockImplementation(() => {})
    const { getByText, container } = render(<Harness onClose={() => {}} />)
    fireEvent.click(getByText('into'))
    fireEvent.click(getByText('into'))
    await waitFor(() => expect(pathText(container)).toBe('Anime/sub/sub'))
    fireEvent.click(getByText('root'))
    await waitFor(() => expect(go).toHaveBeenCalledWith(-2))
    expect(back).not.toHaveBeenCalled()
  })

  it('takes the dialog entry and all folder entries with it when the dialog closes', async () => {
    const go = vi.spyOn(history, 'go').mockImplementation(() => {})
    vi.spyOn(history, 'back').mockImplementation(() => {})
    const { getByText, container, unmount } = render(<Harness onClose={() => {}} />)
    fireEvent.click(getByText('into'))
    fireEvent.click(getByText('into'))
    await waitFor(() => expect(pathText(container)).toBe('Anime/sub/sub'))
    expect(marks()).toBeTruthy()
    unmount()
    // the dialog and two folders: three entries, one step, whatever order they unmounted in
    await waitFor(() => expect(go).toHaveBeenCalledWith(-3))
    expect(go).toHaveBeenCalledTimes(1)
  })

  it('stays out of the way at the start folder', () => {
    const push = vi.spyOn(history, 'pushState')
    render(<Harness onClose={() => {}} />)
    // only the dialog's own entry
    expect(push).toHaveBeenCalledTimes(1)
    act(() => {})
  })

  it('answers a close request (Android back) one folder at a time, not with the dialog', async () => {
    // Chrome sends the back key to the newest close watcher: the dialog's own
    // would close it from any folder, so every folder step holds one
    class FakeWatcher {
      static stack: FakeWatcher[] = []
      onclose: (() => void) | null = null
      constructor() {
        FakeWatcher.stack.push(this)
      }
      destroy() {
        FakeWatcher.stack = FakeWatcher.stack.filter((w) => w !== this)
      }
      static back() {
        const top = FakeWatcher.stack.at(-1)
        top?.destroy()
        top?.onclose?.()
      }
    }
    vi.stubGlobal('CloseWatcher', FakeWatcher)
    const onClose = vi.fn()
    const { getByText, container } = render(<Harness onClose={onClose} />)
    expect(FakeWatcher.stack).toHaveLength(0)
    fireEvent.click(getByText('into'))
    await waitFor(() => expect(FakeWatcher.stack).toHaveLength(1))
    fireEvent.click(getByText('into'))
    await waitFor(() => expect(FakeWatcher.stack).toHaveLength(2))
    act(() => FakeWatcher.back())
    await waitFor(() => expect(pathText(container)).toBe('Anime/sub'))
    expect(FakeWatcher.stack).toHaveLength(1)
    act(() => FakeWatcher.back())
    await waitFor(() => expect(pathText(container)).toBe('Anime'))
    expect(FakeWatcher.stack).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
