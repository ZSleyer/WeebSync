// Third-party license inventory: what the shipped app contains, with the full
// license texts. Three parts, one file each in the end:
//
// - npm: a Vite plugin reads the module ids of the finished bundle, so only
//   packages that actually ship are listed (not all of node_modules).
// - go: the report of go-licenses (TSV through tools/licenses/go.tpl).
// - data: static entries in tools/licenses/data.json (the Go toolchain,
//   vendored assets, the DB-IP database), texts in tools/licenses/texts/.
//
// `merge` writes src/licenses/inventory.json and src/licenses/texts.json,
// `check` fails on a license outside tools/licenses/allowlist.json.
// The entry point for all of it is tools/licenses/generate.sh.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.resolve(HERE, '..')
const REPO = path.resolve(FRONTEND, '..')
// packages of this repository: WeebSync's own code under its AGPL-3.0, not
// third-party (the design system fluid-lycoris lives in design-system/)
const OWN_PACKAGES = new Set(['fluid-lycoris'])
const TOOLS = path.join(REPO, 'tools', 'licenses')
const OUT = path.join(FRONTEND, 'src', 'licenses')

const NOTICE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i

// normText: one text for one notice, whatever the line endings
export const normText = (t) =>
  t
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
export const textId = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16)

// packageRoot maps a module id to the directory of the package it belongs to,
// or null for the app's own code (frontend/src and the design system in
// design-system/, both outside node_modules). Scoped names span two path
// segments.
export function packageRoot(id, { resolveVirtual = virtualRoot } = {}) {
  if (id.startsWith('\0') || !path.isAbsolute(id)) return resolveVirtual(id)
  const file = id.split('?')[0]
  const at = file.lastIndexOf(`${path.sep}node_modules${path.sep}`)
  if (at < 0) return null
  const rest = file.slice(at + '/node_modules/'.length).split(path.sep)
  const segs = rest[0].startsWith('@') ? 2 : 1
  return file.slice(0, at + '/node_modules/'.length) + rest.slice(0, segs).join(path.sep)
}

const require = createRequire(path.join(FRONTEND, 'package.json'))
// Helpers the bundler writes into the output (the preload helper, the
// runtime) come in as virtual ids; their code belongs to the bundler.
function virtualRoot(id) {
  const name = id.replace(/^\0/, '')
  for (const pkg of ['vite', 'rolldown'])
    if (name === pkg || name.startsWith(`${pkg}/`)) return path.dirname(require.resolve(`${pkg}/package.json`))
  return null
}

// spdx: the license field as one SPDX expression; the old object and array
// forms and anything missing become UNKNOWN, which the check refuses
export function spdx(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim()
  return 'UNKNOWN'
}

// repoUrl turns the repository field into a browsable https URL
export function repoUrl(pkg) {
  let r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (r) {
    r = r
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .replace(/^git:\/\//, 'https://')
    r = r.replace(/^git@github\.com:/, 'https://github.com/').replace(/^ssh:\/\/git@/, 'https://')
    if (r.startsWith('github:')) r = `https://github.com/${r.slice(7)}`
    if (/^[\w.-]+\/[\w.-]+$/.test(r)) r = `https://github.com/${r}`
    if (/^https?:\/\//.test(r)) return r.replace(/^http:/, 'https:')
  }
  if (typeof pkg.homepage === 'string' && pkg.homepage.startsWith('https://')) return pkg.homepage
  return `https://www.npmjs.com/package/${pkg.name}`
}

// noticeText: every LICENSE/COPYING/NOTICE file at the package root, in name order
export function noticeText(root) {
  const files = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && NOTICE_FILE.test(e.name))
    .map((e) => e.name)
    .sort()
  const t = files.map((f) => normText(readFileSync(path.join(root, f), 'utf8'))).filter(Boolean)
  return t.length ? t.join('\n\n') : ''
}

// standardText: a package that declares a license but ships no file for it
// gets the license's standard text from tools/licenses/texts/spdx, said so
export function standardText(pkg, license, read = (f) => readFileSync(f, 'utf8')) {
  const file = path.join(TOOLS, 'texts', 'spdx', `${license}.txt`)
  if (!/^[\w.-]+$/.test(license) || !existsSync(file)) return ''
  return `${pkg.name} ${pkg.version} declares ${license} but ships no license file. The standard text of ${license}:\n\n${read(file)}`
}

// Packages in the bundle that are no module of it: Tailwind writes its base
// styles into the CSS through its own plugin.
const ALSO_SHIPPED = ['tailwindcss']

// npmEntries: one entry per package root among the ids, with its notice text
export function npmEntries(ids, opts, also = ALSO_SHIPPED) {
  const roots = new Set(also.map((p) => path.dirname(require.resolve(`${p}/package.json`))))
  for (const id of ids) {
    const r = packageRoot(id, opts)
    if (r) roots.add(r)
  }
  const out = new Map()
  for (const root of roots) {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    const key = `${pkg.name}@${pkg.version}`
    if (out.has(key) || OWN_PACKAGES.has(pkg.name)) continue
    out.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: spdx(pkg),
      url: repoUrl(pkg),
      source: 'npm',
      text: noticeText(root) || standardText(pkg, spdx(pkg)),
    })
  }
  return applyNpmOverrides([...out.values()], readOverrides())
}

const readOverrides = () => JSON.parse(readFileSync(path.join(TOOLS, 'npm-overrides.json'), 'utf8'))

// applyNpmOverrides: some packages bundle more than their license file says
// (jassub's WebAssembly links libass, FreeType, FriBidi, ...). The overrides
// in tools/licenses/npm-overrides.json append texts to such a package and add
// what it bundles as entries of their own. They describe one version: a
// different one in the bundle fails, so they are looked at again. On a
// branch (WEEBSYNC_LICENSES_LENIENT=1, set by CI off main) it only warns, so
// a dependency bump stays mergeable; main keeps failing until it is updated.
export function applyNpmOverrides(
  entries,
  overrides,
  read = (f) => readFileSync(path.join(REPO, f), 'utf8'),
  lenient = process.env.WEEBSYNC_LICENSES_LENIENT === '1',
) {
  const out = []
  for (const e of entries) {
    const o = overrides[e.name]
    if (!o) {
      out.push(e)
      continue
    }
    // one version, or the list of those checked to bundle the same
    if (![o.version].flat().includes(e.version)) {
      const msg = `npm-overrides.json describes ${e.name} ${[o.version].flat().join(', ')}, the bundle has ${e.version}: update it`
      if (!lenient) throw new Error(msg)
      console.warn(`::warning::${msg}`)
    }
    const texts = (fs) => (fs ?? []).map((f) => normText(read(f)))
    out.push({ ...e, text: [e.text, ...texts(o.texts)].filter(Boolean).join('\n\n') })
    for (const { texts: files, ...c } of o.components ?? [])
      out.push({ ...c, source: 'npm', text: texts(files).join('\n\n') })
  }
  return out
}

// licenseInventory: the Vite plugin. With WEEBSYNC_LICENSES_NPM set, a build
// writes the packages of its own bundle there; without it, it does nothing.
export function licenseInventory() {
  return {
    name: 'license-inventory',
    apply: 'build',
    generateBundle(_options, bundle) {
      const outFile = process.env.WEEBSYNC_LICENSES_NPM
      if (!outFile) return
      const ids = []
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') ids.push(...item.moduleIds)
        else ids.push(...(item.originalFileNames ?? []).map((f) => path.resolve(FRONTEND, f)))
      }
      writeFileSync(outFile, JSON.stringify(npmEntries(ids), null, 2) + '\n')
    },
  }
}

// Beside the license go-licenses picked, a module directory can hold more
// notices that bind the binary: NOTICE (Apache-2.0 4(d)), PATENTS, and
// LICENSE-<part> files for code taken in from elsewhere (musl in
// modernc.org/libc's LICENSE-3RD-PARTY.md). The rule: all of them go along,
// unless go-overrides.json skips a file with the package it belongs to and
// a reason; skipProblems then fails as soon as that package gets linked.
const GO_EXTRA = /^(notice|patents)([.-].*)?$|^licen[cs]e-.+$/i

const listDir = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// parseGoReport reads the TSV of tools/licenses/go.tpl:
// name, version, license, url, path of the license file
export function parseGoReport(tsv, { read = (p) => readFileSync(p, 'utf8'), list = listDir, overrides = {} } = {}) {
  const out = []
  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue
    const [name, version, license, url, file] = line.split('\t')
    const o = overrides[name] ?? {}
    const main = o.licenseFile ? path.join(REPO, o.licenseFile) : file
    const dir = path.dirname(main)
    const extra = list(dir)
      .filter((f) => GO_EXTRA.test(f) && !o.skip?.[f])
      .sort()
      .map((f) => path.join(dir, f))
    out.push({
      name,
      version: o.version ?? version,
      license: o.license ?? license,
      url: o.url ?? url,
      source: 'go',
      text: [main, ...extra]
        .map((f) => normText(read(f)))
        .filter(Boolean)
        .join('\n\n'),
    })
  }
  return out
}

// skipProblems: a skipped notice whose package is linked after all (deps is
// `go list -deps` of the binary), or a skip without a reason
export function skipProblems(overrides, deps) {
  const linked = new Set(deps)
  const problems = []
  for (const [name, o] of Object.entries(overrides))
    for (const [file, s] of Object.entries(o.skip ?? {})) {
      if (!s.why) problems.push(`go-overrides: ${name} skips ${file} without a reason`)
      else if (s.package && linked.has(s.package))
        problems.push(`go-overrides: ${name} skips ${file}, but ${s.package} is linked`)
    }
  return problems
}

const goVersion = (v) => v.split('.').map(Number)
const olderThan = (a, b) => {
  const [x, y] = [goVersion(a), goVersion(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

// goToolchainVersion: the Go that builds the shipped binary is the golang
// build image in the Dockerfile; go.mod only names the oldest Go the module
// accepts (go) or wants (toolchain), so the image must not be older
export function goToolchainVersion(dockerfile, gomod) {
  const img = dockerfile.match(/^FROM\s+(?:--\S+\s+)*golang:(\d+\.\d+(?:\.\d+)?)[-@\s]/m)?.[1]
  if (!img) throw new Error('Dockerfile: no golang build image')
  const want = [gomod.match(/^go\s+(\d[\d.]*)\s*$/m)?.[1], gomod.match(/^toolchain\s+go(\d[\d.]*)\s*$/m)?.[1]]
  for (const v of want)
    if (v && olderThan(img, v)) throw new Error(`Dockerfile: golang:${img} is older than go.mod's ${v}`)
  return img
}

// dataEntries: the static ones, texts named by repo-relative paths; the
// version "@go-toolchain" stands for goToolchainVersion
export function dataEntries(data, read = (f) => readFileSync(path.join(REPO, f), 'utf8'), goToolchain = undefined) {
  return data.map(({ texts = [], ...e }) => {
    if (e.version === '@go-toolchain') {
      goToolchain ??= goToolchainVersion(
        readFileSync(path.join(REPO, 'Dockerfile'), 'utf8'),
        readFileSync(path.join(REPO, 'backend', 'go.mod'), 'utf8'),
      )
      e = { ...e, version: goToolchain }
    }
    return { ...e, text: texts.map((f) => normText(read(f))).join('\n\n') }
  })
}

const ORDER = { data: 0, go: 1, npm: 2, os: 3 }

// merge: sorted entries without absolute paths or dates, each text once
export function merge(entries) {
  const texts = {}
  const inventory = entries
    .map(({ text, ...e }) => {
      const t = normText(text ?? '')
      if (!t) return e
      const id = textId(t)
      texts[id] = t
      return { ...e, text: id }
    })
    .sort(
      (a, b) =>
        ORDER[a.source] - ORDER[b.source] ||
        a.name.localeCompare(b.name, 'en') ||
        a.version.localeCompare(b.version, 'en'),
    )
  const sortedTexts = Object.fromEntries(Object.entries(texts).sort(([a], [b]) => (a < b ? -1 : 1)))
  return { inventory, texts: sortedTexts }
}

// ---- the allowlist check ----

// parseSpdx: an SPDX expression into a tree of AND/OR nodes; WITH stays part
// of the license id ("GPL-2.0-or-later WITH Classpath-exception-2.0")
export function parseSpdx(expr) {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? []
  let i = 0
  const primary = () => {
    const t = tokens[i++]
    if (t === '(') {
      const e = or()
      if (tokens[i++] !== ')') throw new Error(`unbalanced ( in "${expr}"`)
      return e
    }
    if (!t || t === ')' || /^(AND|OR|WITH)$/i.test(t)) throw new Error(`bad SPDX expression "${expr}"`)
    if (/^WITH$/i.test(tokens[i] ?? '')) {
      i++
      return { id: `${t} WITH ${tokens[i++]}` }
    }
    return { id: t }
  }
  const and = () => {
    let l = primary()
    while (/^AND$/i.test(tokens[i] ?? '')) {
      i++
      l = { and: [l, primary()] }
    }
    return l
  }
  const or = () => {
    let l = and()
    while (/^OR$/i.test(tokens[i] ?? '')) {
      i++
      l = { or: [l, and()] }
    }
    return l
  }
  const tree = or()
  if (i !== tokens.length) throw new Error(`trailing tokens in "${expr}"`)
  return tree
}

// allowedBy: is the expression satisfiable with the allowed ids? OR takes
// either side, AND needs both
export function allowedBy(expr, allowed) {
  const ok = (n) => (n.id ? allowed.has(n.id) : n.or ? n.or.some(ok) : n.and.every(ok))
  try {
    return ok(parseSpdx(expr))
  } catch {
    return false
  }
}

// check: the entries whose license is neither allowed nor an explained
// exception for exactly that package
export function check(inventory, allowlist) {
  const allowed = new Set(allowlist.allowed)
  const problems = []
  for (const e of inventory) {
    const ex = allowlist.exceptions?.[e.name]
    if (ex && ex.license === e.license) continue
    if (!allowedBy(e.license, allowed)) problems.push(`${e.source} ${e.name}@${e.version}: ${e.license}`)
  }
  for (const [name, ex] of Object.entries(allowlist.exceptions ?? {}))
    if (!ex.why) problems.push(`allowlist exception ${name} gives no reason`)
  return problems
}

// ---- CLI ----

const readJSON = (f) => JSON.parse(readFileSync(f, 'utf8'))
const writeJSON = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + '\n')

function main([cmd, ...args]) {
  const opt = (name) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  if (cmd === 'merge') {
    const goFile = opt('go')
    const npmFile = opt('npm')
    const depsFile = opt('deps')
    if (!goFile || !npmFile || !depsFile)
      throw new Error('usage: licenses.mjs merge --go <report.tsv> --npm <npm.json> --deps <go-deps.txt>')
    const overrides = readJSON(path.join(TOOLS, 'go-overrides.json'))
    const skips = skipProblems(overrides, readFileSync(depsFile, 'utf8').split('\n'))
    for (const p of skips) console.error(`licenses: ${p}`)
    if (skips.length) return 1
    const entries = [
      ...dataEntries(readJSON(path.join(TOOLS, 'data.json'))),
      ...parseGoReport(readFileSync(goFile, 'utf8'), { overrides }),
      ...readJSON(npmFile),
    ]
    const { inventory, texts } = merge(entries)
    writeJSON(path.join(OUT, 'inventory.json'), inventory)
    writeJSON(path.join(OUT, 'texts.json'), texts)
    console.log(`licenses: ${inventory.length} entries, ${Object.keys(texts).length} texts`)
    return 0
  }
  if (cmd === 'check') {
    const inventory = readJSON(path.join(OUT, 'inventory.json'))
    const problems = check(inventory, readJSON(path.join(TOOLS, 'allowlist.json')))
    const missing = inventory.filter((e) => !e.text && e.source !== 'data').map((e) => `${e.name}: no license text`)
    for (const p of [...problems, ...missing]) console.error(`licenses: ${p}`)
    if (problems.length || missing.length) return 1
    console.log(`licenses: ${inventory.length} entries within the allowlist`)
    return 0
  }
  throw new Error('usage: licenses.mjs merge|check')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && existsSync(OUT))
  process.exitCode = main(process.argv.slice(2))
