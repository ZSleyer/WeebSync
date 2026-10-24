/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WCAG 2.4.7: a focus ring follows the browser's :focus-visible. Only a
// pointer press (html[data-input=pointer]) may switch it off, never the
// absence of a navigation key (voice control and switch access send none).

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : p.endsWith('.css') ? [p] : []
  })
const files = [...walk(resolve(process.cwd(), 'src')), ...walk(resolve(process.cwd(), '../design-system/src'))]

// focus that is not the user's to see: moved by the router, or a field whose
// own border takes the full accent colour (3:1) instead of an outline
const EXEMPT = ['.app-shell > main', '.ws-detail:focus', '.t-input:focus', '.t-select:focus']

// a selector list split at its top-level commas (not those inside :is(...))
const split = (list: string): string[] => {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of list) {
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += c
  }
  return [...out, cur.trim()]
}

interface Rule {
  file: string
  selectors: string[]
  body: string
}
const rules: Rule[] = files.flatMap((file) => {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    file,
    selectors: split(m[1]),
    body: m[2],
  }))
})

describe('focus ring policy', () => {
  it('scans the stylesheets', () => {
    expect(files.length).toBeGreaterThan(5)
    expect(rules.length).toBeGreaterThan(200)
  })

  it('removes an outline on :focus only behind a pointer gate', () => {
    const bad = rules.flatMap((r) =>
      /outline:\s*(none|0)\b/.test(r.body)
        ? r.selectors
            .filter(
              (s) => /:focus/.test(s) && !/data-input=['"]pointer['"]/.test(s) && !EXEMPT.some((e) => s.includes(e)),
            )
            .map((s) => `${r.file}: ${s}`)
        : [],
    )
    expect(bad).toEqual([])
  })

  it('never makes a custom ring depend on a navigation key having been pressed', () => {
    const bad = rules.flatMap((r) =>
      r.selectors.filter((s) => /(?<!:not\()\[data-input=['"]keys['"]\]/.test(s)).map((s) => `${r.file}: ${s}`),
    )
    expect(bad).toEqual([])
  })
})
