import { describe, expect, it } from 'vitest'
import de from '../locales/de.json'
import en from '../locales/en.json'

// Every static t('key') in the app has to resolve in both languages: a
// missing key renders as the raw key ("setup.stepOf") and nothing else
// notices. Template keys (t(`a.${b}`)) are out of reach of a regex and are
// left to their defaultValue.

const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../test/**', '!../**/*.gen.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

type Tree = { [k: string]: string | Tree }

const leaves = (o: Tree, p = '', out = new Set<string>()) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k
    if (typeof v === 'string') out.add(key)
    else leaves(v, key, out)
  }
  return out
}

const PLURAL = ['', '_zero', '_one', '_two', '_few', '_many', '_other']
const resolves = (set: Set<string>, key: string) => PLURAL.some((s) => set.has(key + s))

const used = () => {
  const keys = new Map<string, string>()
  for (const [file, src] of Object.entries(sources))
    for (const m of src.matchAll(/\bt\(\s*(['"])([A-Za-z][\w.-]*)\1/g)) keys.set(m[2], file)
  return keys
}

describe('locale keys', () => {
  const DE = leaves(de as Tree)
  const EN = leaves(en as Tree)

  it('finds the keys it checks', () => {
    expect(used().size).toBeGreaterThan(500)
  })

  it('resolves every static key in both languages', () => {
    const missing = [...used()].filter(([k]) => !resolves(DE, k) || !resolves(EN, k)).map(([k, f]) => `${k} (${f})`)
    expect(missing).toEqual([])
  })

  it('keeps both languages on the same keys', () => {
    expect([...DE].filter((k) => !EN.has(k))).toEqual([])
    expect([...EN].filter((k) => !DE.has(k))).toEqual([])
  })
})
