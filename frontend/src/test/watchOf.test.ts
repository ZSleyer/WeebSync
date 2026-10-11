import { describe, expect, it } from 'vitest'
import type { Watch } from '../api'
import { watchOf } from '../components/playLinks'

const w = (id: number, serverId: number, remotePath: string, localPath: string, subfolder = false) =>
  ({ id, serverId, remotePath, localPath, subfolder }) as Watch

describe('watchOf', () => {
  const watches = [
    w(1, 2, '/FTP/Summer/Show A [Sub]', 'Show A/Season 01'),
    w(2, 2, '/FTP/Summer/Show B', 'Anime', true),
  ]

  it('finds a local file by the tail of its absolute folder', () => {
    expect(watchOf(watches, 0, '/media/lib/Show A/Season 01/Show A - S01E01.mkv')?.id).toBe(1)
    expect(watchOf(watches, 0, '/media/lib/Anime/Show B/x.mkv')?.id).toBe(2)
  })

  it('finds a remote file on the watch server only', () => {
    expect(watchOf(watches, 2, '/FTP/Summer/Show A [Sub]/ep.mkv')?.id).toBe(1)
    expect(watchOf(watches, 3, '/FTP/Summer/Show A [Sub]/ep.mkv')).toBeUndefined()
  })

  it('does not match a folder that merely ends alike', () => {
    expect(watchOf(watches, 0, '/media/lib/Other Show A/Season 01/x.mkv')).toBeUndefined()
  })
})
