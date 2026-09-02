import type { TFunction } from 'i18next'

// A job key carries ids ("crawl:2", "m:1:/Show"); the family is what the UI
// talks about and what pause acts on. Same rule as the backend's jobFamily.
export const jobFamily = (key: string) => (key.includes(':') ? key.slice(0, key.indexOf(':')) : key)

// jobLabel names a family in the user's language. An unknown family falls back
// to its raw key rather than an empty chip: a new job should still be legible
// before anyone gets around to translating it.
export function jobLabel(t: TFunction, family: string) {
  const key = `jobs.family.${family}`
  const label = t(key)
  return label === key ? family : label
}
