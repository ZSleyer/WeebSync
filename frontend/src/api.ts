// Typed fetch helpers for the WeebSync API.

export interface User {
  id: number
  email: string
  isAdmin: boolean
}

export interface UserAccount {
  id: number
  email: string
  isAdmin: boolean
  createdAt: string
}

export interface ServerInfo {
  id: number
  name: string
  protocol: 'sftp' | 'ftps' | 'ftp'
  host: string
  port: number
  username: string
  rootPath: string
}

export interface Entry {
  name: string
  path: string
  size: number
  isDir: boolean
  modTime: string
}

export interface Download {
  id: number
  userId: number
  serverId: number
  remotePath: string
  localPath: string
  size: number
  transferred: number
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'canceled'
  error?: string
  rateLimit: number
  bytesPerSec?: number
  createdAt: string
}

export interface Media {
  id: number
  title: { romaji: string; english: string }
  coverImage: { large: string }
  bannerImage: string
  trailer?: { id: string; site: string; thumbnail: string } | null
  nextAiringEpisode?: { airingAt: number; episode: number } | null
  episodes: number
  seasonYear: number
  format: string
  status: string
  averageScore: number
  genres: string[]
  description: string
}

export interface CatalogItem {
  entry: Entry
  media?: Media
  pending?: boolean // metadata still resolving in the background
}

export interface Watch {
  id: number
  userId: number
  serverId: number
  serverName: string
  remotePath: string
  localPath: string
  mode: string
  template: string
  separator: string
  titleOverride: string
  pattern: string
  replacement: string
  intervalMin: number
  lastCheck: string
  lastResult: string
  createdAt: string
  media?: Media
  localFiles: number
  active: number
  complete: boolean
  nextEpisode?: number
  nextAiringAt?: number
  waiting: boolean
}

export interface SearchResult {
  results: Entry[]
  indexed: number
}

export interface RenamePair {
  old: string
  new: string
  error?: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const data = await res.json()
      if (data.error) msg = data.error
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg)
  }
  return res.json()
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let u = -1
  do {
    v /= 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`
}

export function fmtSpeed(bps: number): string {
  return `${fmtBytes(bps)}/s`
}
