// Typed fetch helpers for the WeebSync API.

export interface User {
  id: number
  email: string
  isAdmin: boolean
}

export interface AuthConfig {
  oidc: boolean
  registrationOpen: boolean
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
  episodes: number
  seasonYear: number
  format: string
  averageScore: number
  genres: string[]
  description: string
}

export interface CatalogItem {
  entry: Entry
  media?: Media
}

export interface Settings {
  maxConcurrent: number
  globalRateLimit: number
  registrationDisabled: boolean
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
