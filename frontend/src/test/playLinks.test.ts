import { describe, expect, it, vi } from 'vitest'
import type { Entry } from '../api'

const listings: Record<string, Entry[]> = {}
vi.mock('../api', () => ({
  api: {
    get: vi.fn((url: string) => Promise.resolve(listings[new URL(url, 'http://x').searchParams.get('path')!] ?? [])),
  },
}))

const { firstVideo, videosIn } = await import('../components/playLinks')

const file = (path: string): Entry => ({ name: path.split('/').pop()!, path, size: 1, isDir: false, modTime: '' })
const dir = (path: string): Entry => ({ ...file(path), isDir: true })

describe('playLinks', () => {
  it('lists the videos of a folder in episode order', () => {
    const got = videosIn([
      file('/s/E10.mkv'),
      file('/s/E2.mkv'),
      file('/s/notes.txt'),
      dir('/s/extras'),
      file('/s/E1.mp4'),
    ])
    expect(got.map((e) => e.name)).toEqual(['E1.mp4', 'E2.mkv', 'E10.mkv'])
  })

  it('finds the first episode in a title folder or its first season', async () => {
    listings['/Flat'] = [file('/Flat/B.mkv'), file('/Flat/A.mkv')]
    listings['/Show'] = [dir('/Show/Season 02'), dir('/Show/Season 01'), file('/Show/poster.jpg')]
    listings['/Show/Season 01'] = [file('/Show/Season 01/S01E02.mkv'), file('/Show/Season 01/S01E01.mkv')]
    listings['/Empty'] = [dir('/Empty/x')]
    expect(await firstVideo(0, '/Flat')).toBe('/Flat/A.mkv')
    expect(await firstVideo(0, '/Show')).toBe('/Show/Season 01/S01E01.mkv')
    expect(await firstVideo(0, '/Empty')).toBeNull()
  })
})
