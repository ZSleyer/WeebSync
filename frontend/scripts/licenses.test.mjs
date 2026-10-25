import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  allowedBy,
  check,
  dataEntries,
  goToolchainVersion,
  merge,
  packageRoot,
  parseGoReport,
  repoUrl,
  skipProblems,
  spdx,
  textId,
} from './licenses.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ds = path.join(repo, 'design-system')

describe('license inventory', () => {
  it('maps module ids to their package root, scoped names included', () => {
    const nm = '/x/frontend/node_modules'
    expect(packageRoot(`${nm}/react/cjs/react.production.js`, { designSystem: ds })).toBe(`${nm}/react`)
    expect(packageRoot(`${nm}/@tanstack/query-core/build/modern/index.js?commonjs`, { designSystem: ds })).toBe(
      `${nm}/@tanstack/query-core`,
    )
    // a nested copy counts as its own package
    expect(packageRoot(`${nm}/a/node_modules/b/index.js`, { designSystem: ds })).toBe(`${nm}/a/node_modules/b`)
    expect(packageRoot(`${ds}/src/controls.tsx`, { designSystem: ds })).toBe(ds)
    // the app's own code is no third party
    expect(packageRoot('/x/frontend/src/main.tsx', { designSystem: ds })).toBeNull()
    expect(packageRoot(`${ds}-other/src/x.ts`, { designSystem: ds })).toBeNull()
  })

  it('credits the bundler for its helpers and drops other virtual modules', () => {
    const resolveVirtual = (id) => (id.replace(/^\0/, '').startsWith('vite/') ? '/vite' : null)
    expect(packageRoot('\0vite/preload-helper.js', { designSystem: ds, resolveVirtual })).toBe('/vite')
    expect(packageRoot('\0commonjsHelpers.js', { designSystem: ds, resolveVirtual })).toBeNull()
  })

  it('takes only an SPDX string as the license and turns repositories into links', () => {
    expect(spdx({ license: 'MIT' })).toBe('MIT')
    expect(spdx({ license: { type: 'MIT' } })).toBe('UNKNOWN')
    expect(spdx({ licenses: [{ type: 'MIT' }] })).toBe('UNKNOWN')
    expect(repoUrl({ name: 'a', repository: { url: 'git+https://github.com/o/a.git' } })).toBe('https://github.com/o/a')
    expect(repoUrl({ name: 'a', repository: 'o/a' })).toBe('https://github.com/o/a')
    expect(repoUrl({ name: 'a', repository: 'github:o/a' })).toBe('https://github.com/o/a')
    expect(repoUrl({ name: 'a' })).toBe('https://www.npmjs.com/package/a')
  })

  it('reads the go-licenses report with overrides and without its file paths', () => {
    const tsv =
      'example.com/a\tv1.0.0\tMIT\thttps://example.com/a/LICENSE\t/home/u/go/pkg/mod/example.com/a@v1.0.0/LICENSE\n' +
      'example.com/b\tUnknown\tBSD-2-Clause\tUnknown\t/src/third_party/b/LICENSE\n'
    const out = parseGoReport(tsv, {
      read: (p) => `text of ${path.basename(path.dirname(p))}\r\n`,
      overrides: { 'example.com/b': { version: 'v2.0.0', url: 'https://example.com/b' } },
    })
    expect(out).toEqual([
      {
        name: 'example.com/a',
        version: 'v1.0.0',
        license: 'MIT',
        url: 'https://example.com/a/LICENSE',
        source: 'go',
        text: 'text of a@v1.0.0',
      },
      {
        name: 'example.com/b',
        version: 'v2.0.0',
        license: 'BSD-2-Clause',
        url: 'https://example.com/b',
        source: 'go',
        text: 'text of b',
      },
    ])
  })

  it('sorts by source and name and keeps each text once', () => {
    const { inventory, texts } = merge([
      { name: 'z', version: '1', license: 'MIT', url: 'u', source: 'npm', text: 'MIT text\r\n' },
      { name: 'a', version: '1', license: 'MIT', url: 'u', source: 'npm', text: 'MIT text' },
      { name: 'g', version: '1', license: 'MIT', url: 'u', source: 'go', text: 'other' },
      { name: 'd', version: '1', license: 'CC-BY-4.0', url: 'u', source: 'data', text: '' },
    ])
    expect(inventory.map((e) => `${e.source}:${e.name}`)).toEqual(['data:d', 'go:g', 'npm:a', 'npm:z'])
    expect(inventory[2].text).toBe(textId('MIT text'))
    expect(inventory[3].text).toBe(inventory[2].text)
    expect(inventory[0].text).toBeUndefined()
    expect(Object.keys(texts)).toHaveLength(2)
  })

  it('evaluates SPDX expressions: OR takes either side, AND needs both', () => {
    const ok = new Set(['MIT', 'FTL', 'Apache-2.0'])
    expect(allowedBy('MIT', ok)).toBe(true)
    expect(allowedBy('(MIT OR GPL-3.0-only)', ok)).toBe(true)
    expect(allowedBy('MIT AND (FTL OR GPL-2.0-or-later)', ok)).toBe(true)
    expect(allowedBy('MIT AND GPL-2.0-or-later', ok)).toBe(false)
    expect(allowedBy('Apache-2.0 WITH LLVM-exception', ok)).toBe(false)
    expect(allowedBy('MIT AND', ok)).toBe(false)
    expect(allowedBy('UNKNOWN', ok)).toBe(false)
  })

  it('flags copyleft and unknown licenses unless an exception explains exactly that package', () => {
    const inv = [
      { name: 'ok', version: '1', license: 'MIT', source: 'npm' },
      { name: 'gpl', version: '1', license: 'GPL-3.0', source: 'npm' },
      { name: 'agpl', version: '1', license: 'AGPL-3.0-only', source: 'go' },
      { name: 'none', version: '1', license: 'UNKNOWN', source: 'npm' },
    ]
    const list = { allowed: ['MIT'], exceptions: { gpl: { license: 'GPL-3.0', why: 'section 13' } } }
    expect(check(inv, list)).toEqual(['go agpl@1: AGPL-3.0-only', 'npm none@1: UNKNOWN'])
    // a changed license string is checked again
    expect(check([{ ...inv[1], license: 'GPL-3.0-only' }], list)).toEqual(['npm gpl@1: GPL-3.0-only'])
    // and an exception needs its reason
    expect(check([], { allowed: [], exceptions: { x: { license: 'GPL-3.0' } } })).toEqual([
      'allowlist exception x gives no reason',
    ])
  })

  it('the committed inventory passes the committed allowlist and carries no paths', () => {
    const inv = JSON.parse(readFileSync(path.join(repo, 'frontend/src/licenses/inventory.json'), 'utf8'))
    const list = JSON.parse(readFileSync(path.join(repo, 'tools/licenses/allowlist.json'), 'utf8'))
    expect(check(inv, list)).toEqual([])
    const raw = readFileSync(path.join(repo, 'frontend/src/licenses/inventory.json'), 'utf8')
    expect(raw).not.toMatch(/"\/(home|tmp|root|Users)\//)
    for (const e of inv)
      expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(['license', 'name', 'source', 'url', 'version']))
  })
})

describe('Go modules: every notice next to the license', () => {
  const dir = '/mod/example.com/a@v1.0.0'
  const files = {
    [`${dir}/LICENSE`]: 'main license',
    [`${dir}/NOTICE`]: 'notice of a',
    [`${dir}/LICENSE-3RD-PARTY.md`]: 'musl and friends',
    [`${dir}/LICENSE-VEC`]: 'vec license',
    [`${dir}/README.md`]: 'not a license',
  }
  const read = (p) => files[p]
  const list = (d) =>
    Object.keys(files)
      .filter((f) => path.dirname(f) === d)
      .map((f) => path.basename(f))
  const tsv = `example.com/a\tv1.0.0\tApache-2.0\thttps://example.com/a\t${dir}/LICENSE\n`

  it('adds NOTICE and LICENSE-* files of the module directory to the text', () => {
    const [e] = parseGoReport(tsv, { read, list })
    expect(e.text).toBe('main license\n\nmusl and friends\n\nvec license\n\nnotice of a')
  })

  it('leaves out a file the overrides skip for a package that is not linked', () => {
    const overrides = {
      'example.com/a': { skip: { 'LICENSE-VEC': { package: 'example.com/a/vec', why: 'not imported' } } },
    }
    const [e] = parseGoReport(tsv, { read, list, overrides })
    expect(e.text).not.toContain('vec license')
    expect(e.text).toContain('notice of a')
    expect(skipProblems(overrides, ['example.com/a', 'example.com/b'])).toEqual([])
    // once the package is linked after all, the skip is wrong and says so
    expect(skipProblems(overrides, ['example.com/a', 'example.com/a/vec'])).toEqual([
      'go-overrides: example.com/a skips LICENSE-VEC, but example.com/a/vec is linked',
    ])
    expect(skipProblems({ x: { skip: { F: { package: 'p' } } } }, [])).toEqual([
      'go-overrides: x skips F without a reason',
    ])
  })

  it('the committed inventory carries the go-oidc NOTICE and the musl notice of modernc.org/libc', () => {
    const inv = JSON.parse(readFileSync(path.join(repo, 'frontend/src/licenses/inventory.json'), 'utf8'))
    const texts = JSON.parse(readFileSync(path.join(repo, 'frontend/src/licenses/texts.json'), 'utf8'))
    const textOf = (name) => texts[inv.find((e) => e.name === name).text]
    expect(textOf('github.com/coreos/go-oidc/v3/oidc')).toContain('CoreOS Project')
    expect(textOf('modernc.org/libc')).toMatch(/musl/i)
    expect(textOf('modernc.org/sqlite')).toContain('SQLite Is Public Domain')
  })
})

describe('the Go toolchain entry', () => {
  const dockerfile = 'FROM node AS web\nFROM --platform=$BUILDPLATFORM golang:1.27.3-alpine@sha256:abc AS build\n'

  it('takes its version from the image that builds the binary', () => {
    expect(goToolchainVersion(dockerfile, 'module x\n\ngo 1.26.10\n')).toBe('1.27.3')
    const [e] = dataEntries([{ name: 'Go', version: '@go-toolchain', texts: [] }], () => '', '1.27.3')
    expect(e.version).toBe('1.27.3')
  })

  it('refuses a build image older than go.mod asks for, or none at all', () => {
    expect(() => goToolchainVersion(dockerfile, 'go 1.28.0\n')).toThrow(/older than go.mod/)
    expect(() => goToolchainVersion(dockerfile, 'go 1.26.10\ntoolchain go1.27.4\n')).toThrow(/older than go.mod/)
    expect(() => goToolchainVersion('FROM alpine\n', 'go 1.26\n')).toThrow(/no golang build image/)
  })

  it('the committed Go entry matches the Dockerfile', () => {
    const inv = JSON.parse(readFileSync(path.join(repo, 'frontend/src/licenses/inventory.json'), 'utf8'))
    const go = inv.find((e) => e.name === 'Go standard library and runtime')
    const want = goToolchainVersion(
      readFileSync(path.join(repo, 'Dockerfile'), 'utf8'),
      readFileSync(path.join(repo, 'backend/go.mod'), 'utf8'),
    )
    expect(go.version).toBe(want)
    const data = JSON.parse(readFileSync(path.join(repo, 'tools/licenses/data.json'), 'utf8'))
    expect(data.find((e) => e.name === go.name).version).toBe('@go-toolchain')
  })
})
