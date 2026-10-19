// Opens every dialog the app has and audits it the way e2e.mjs audits a page:
// control heights per row, target size, and above all scrollbars - a modal is
// where a stray one hurts most, and a page-level pass never sees it because the
// dialog is not in the DOM until something is clicked.
//
//   WS_EMAIL=... WS_PASSWORD=... node tools/ui-audit/modals.mjs [--base http://127.0.0.1:8080]
import { chromium, firefox } from 'playwright'
import { scanLayout } from './overlap.mjs'
import { launch, signIn } from './auth.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:8080')
// WS_LANG=en audits the English UI; German is the default
const LANG = process.env.WS_LANG === 'en' ? 'en' : 'de'

// route -> the controls that open a dialog there, by accessible name. `setup`
// runs first for views that are not the route's default, and returns false
// when the state it needs is not there. The names match both UI languages,
// since the app may come up in either one for the account under test.

// clicks a control if it is on the page; false when it is not
const tap = async (page, role, name, wait = 800) => {
  const el = page.getByRole(role, { name }).first()
  try {
    await el.waitFor({ state: 'visible', timeout: 5000 })
    await el.click({ timeout: 3000 })
  } catch {
    return false
  }
  await page.waitForTimeout(wait)
  return true
}

// the series page of the first watch: a page laid over the list, not a dialog,
// so it is the starting point for the dialogs it opens rather than a finding
const openSeries = async (page) => {
  const tile = page.locator('.w-tile').first()
  try {
    await tile.waitFor({ state: 'visible', timeout: 5000 })
    await tile.click({ timeout: 3000 })
  } catch {
    return false
  }
  await page.waitForTimeout(1200)
  return true
}

// the catalogue of the first folder that matched a title, in the poster grid
const openCatalogue = async (page) => {
  // The detail modal only exists where a folder actually matched a title,
  // and a server's root is usually a shelf of unmatched folders - which is
  // how the tallest dialog in the app went unaudited while every run still
  // reported a clean sweep. Ask the API for the first folder that has a
  // match rather than hardcoding a path out of somebody's library.
  const target = await page.evaluate(async () => {
    const servers = await (await fetch('/api/servers', { credentials: 'include' })).json()
    // local first: every step below is a live listing, and this audit runs
    // six browser contexts at once - a remote box would see six parallel
    // walks. A local test server answers all of them without complaining.
    const local = servers.filter((s) => /^(localhost|127\.|\[?::1)/.test(s.host))
    const queue = (local.length ? local : servers).map((s) => ({ id: s.id, path: '' }))
    // every step is a live listing on a real server, so the walk stays on a
    // short leash and settles for whatever it has found by then
    for (let i = 0; i < 8 && queue.length; i++) {
      const { id, path } = queue.shift()
      const r = await fetch(`/api/servers/${id}/catalog${path ? `?path=${encodeURIComponent(path)}` : ''}`, {
        credentials: 'include',
      })
      if (!r.ok) continue
      const items = (await r.json()).items || []
      if (items.some((it) => it.media)) return { id, path }
      for (const it of items) queue.push({ id, path: it.entry.path })
    }
    return null
  })
  if (!target) return false
  await page.goto(`${BASE}/files?server=${target.id}&path=${encodeURIComponent(target.path.replace(/^\//, ''))}`)
  await page.waitForTimeout(2500)
  // the catalogue is the default view; a stored choice may have left the
  // classic list on, so pick it by name rather than by position
  await tap(page, 'button', /^Katalog$|^Catalog$/, 1500)
  return (await page.getByRole('article').count().catch(() => 0)) > 0
}

const TRIGGERS = [
  // reached by a CSS selector where the control has no stable name: the live
  // activity's transfer sheet. Only there while something transfers, so a run
  // over an idle instance skips it instead of failing on it.
  { route: '/', label: 'Transfers', css: '.t-live', names: ['live'], optional: 'a transfer in progress' },
  // the search: a tab on the phone, a field in the header on the desktop
  { route: '/', label: 'Search', names: [/^Suchen|^Search/] },
  // adding and editing a server are pages of their own (/settings/servers/new
  // and /:id, which e2e.mjs walks), so only the delete confirmation is a dialog
  { route: '/settings/servers', names: [/^Löschen$|^Delete$/] },
  // A watch opens as a series page, and its editor replaces that page's
  // content in place: neither is a dialog. The dialog there is the page's
  // overflow, an action sheet on a phone (on the desktop it is a menu, which
  // is not a dialog and so is not reported). Its delete entry acts at once
  // with an undo line, so it is deliberately not a trigger.
  { route: '/watches', label: 'Series page', setup: openSeries, names: [/^Weitere Aktionen für|^More actions for/] },
  {
    // nested: the Plex picker only exists inside the watch editor, and only
    // with Plex connected
    route: '/watches',
    label: 'Plex series',
    setup: async (page) => (await openSeries(page)) && (await tap(page, 'button', /^Bearbeiten$|^Edit$/, 900)),
    names: [/^Ändern$|^Change$/],
    optional: 'a connected Plex server',
  },
  // the catalogue of the local library: why a folder matched or did not, and
  // a folder's action sheet. Renaming happens inline in the row, so there is
  // no prompt dialog left to reach.
  {
    route: '/files?source=local',
    label: 'Local catalogue',
    names: [/^Warum\?$|^Why\?$/, /^Weitere Aktionen für|^More actions for/],
  },
  // /files itself has no dialog of its own - the file list is a view, not a
  // modal, and every modal on that route lives in the catalogue below. They
  // need a folder on a reachable server that matched a title.
  {
    route: '/files',
    label: 'Catalogue',
    setup: openCatalogue,
    names: [/Details zu|Details for/, /Match ändern|Change match/, /Syncen|Sync/],
    optional: 'a server folder that matched a title',
  },
  // the same catalogue as rows: the title card opens from the row's cover
  // and its Details button
  {
    route: '/files',
    label: 'Catalogue list',
    setup: async (page) => {
      if (!(await openCatalogue(page))) return false
      const list = page.getByRole('group', { name: /Darstellung|Layout/ }).getByRole('button').nth(1)
      if (!(await list.count().catch(() => 0))) return false
      await list.click()
      await page.waitForTimeout(800)
      return true
    },
    names: [/Details zu|Details for/],
    optional: 'a server folder that matched a title',
  },
  // flushing the index sits behind the server card's menu and asks first
  {
    route: '/settings/matching',
    label: 'Menu',
    setup: (page) => tap(page, 'button', /^Weitere Aktionen$|^More actions$/, 400),
    role: 'menuitem',
    names: [/^Index leeren$|^Flush index$/],
  },
  // the reset dialog is the widest one in the app: it lists every data store
  // as a chip, and the longest of those labels is what a phone has to fit
  { route: '/settings/data', names: [/Alles neu aufbauen|Rebuild everything/] },
]

const ALL_VIEWPORTS = {
  phone: { viewport: { width: 448, height: 998 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  wide: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
  pixel: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  iphone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
}
// --viewports and --browsers pick a subset, as in e2e.mjs
const VIEWPORTS = Object.fromEntries(
  arg('viewports', 'desktop,pixel,iphone').split(',').map((k) => [k, ALL_VIEWPORTS[k]]),
)
const BROWSERS = arg('browsers', 'chromium,firefox').split(',')

const auditDialog = () => {
  // the *last* one open, not the first: a dialog can open a dialog (the Plex
  // picker inside the watch dialog), and the one on top is the one under test
  const d = [...document.querySelectorAll('dialog[open]')].pop()
  if (!d) return null
  const vis = (e) => {
    const cs = getComputedStyle(e)
    const r = e.getBoundingClientRect()
    return cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 0 && r.height > 0
  }
  const name = (e) => `${e.tagName.toLowerCase()}.${e.className.toString().slice(0, 45)}`

  // scrollbars: the dialog element itself must never scroll, and no inner box
  // may overflow by the handful of pixels that means "layout slipped"
  const scroll = []
  const dcs = getComputedStyle(d)
  const dOver = { y: d.scrollHeight - d.clientHeight, x: d.scrollWidth - d.clientWidth }
  // overflow:hidden still reports the overflow, but cannot show a bar
  const dScrolls = ['auto', 'scroll'].includes(dcs.overflowY) || ['auto', 'scroll'].includes(dcs.overflowX)
  if (dScrolls && (dOver.y > 0 || dOver.x > 0)) scroll.push({ where: 'the dialog itself', ...dOver })
  for (const e of d.querySelectorAll('*')) {
    if (!vis(e)) continue
    const cs = getComputedStyle(e)
    if (cs.scrollbarWidth === 'none') continue
    const oy = e.scrollHeight - e.clientHeight, ox = e.scrollWidth - e.clientWidth
    if (['auto', 'scroll'].includes(cs.overflowX) && ox > 1) scroll.push({ where: name(e), x: ox })
    if (['auto', 'scroll'].includes(cs.overflowY) && oy > 1 && oy <= 8) scroll.push({ where: name(e), y: oy })
  }

  // Sideways is the failure a scrollbar check cannot see here: the dialog is
  // `overflow: hidden`, so anything too wide is neither scrollable nor visible -
  // it is cut off at the edge, and on the narrowest phone that is where a label
  // or a button row gives out first. Measure the boxes against the dialog
  // instead of asking it for a scroll width it will never report.
  const dr = d.getBoundingClientRect()
  if (dr.right > innerWidth + 1 || dr.left < -1)
    scroll.push({ where: `dialog sticks out of the viewport by ${Math.round(Math.max(dr.right - innerWidth, -dr.left))}px`, x: Math.round(Math.max(dr.right - innerWidth, -dr.left)) })
  let out = 0, widest = null
  for (const e of d.querySelectorAll('*')) {
    if (!vis(e)) continue
    if (getComputedStyle(e).position === 'fixed') continue
    // content inside a box that scrolls sideways on purpose stays reachable
    let reachable = false
    for (let p = e.parentElement; p && p !== d; p = p.parentElement)
      if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX)) { reachable = true; break }
    if (reachable) continue
    const over = Math.round(e.getBoundingClientRect().right - dr.right)
    if (over > out) { out = over; widest = name(e) }
  }
  if (out > 1) scroll.push({ where: `${widest} sticks out of the dialog by ${out}px`, x: out })

  // target size 2.5.8
  // the target is the hit area: a link in running text draws it with an
  // absolutely positioned pseudo-element around its text, so its own box can
  // stay a line tall without failing 2.5.8
  const hitBox = (el) => {
    const b = el.getBoundingClientRect()
    let { width, height } = b
    for (const which of ['::before', '::after']) {
      const s = getComputedStyle(el, which)
      if (s.position !== 'absolute' || s.content === 'none' || s.content === 'normal') continue
      const px = (v) => parseFloat(v) || 0
      width = Math.max(width, b.width - px(s.left) - px(s.right))
      height = Math.max(height, b.height - px(s.top) - px(s.bottom))
    }
    return { width, height }
  }
  const targets = []
  for (const e of d.querySelectorAll('a[href], button, input, select, textarea')) {
    if (!vis(e) || e.disabled) continue
    const cs = getComputedStyle(e)
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') continue
    if (e.tagName === 'A' && cs.display.startsWith('inline')) continue
    const b = hitBox(e)
    if (b.width < 24 || b.height < 24) targets.push(`${name(e)} ${b.width.toFixed(1)}x${b.height.toFixed(1)}`)
  }

  // heights per row, same rule as the page pass
  const rows = []
  for (const sel of [
    '.t-btn:not(.t-btn--sm), .t-input:not(.t-input--sm):not(textarea), .t-select:not(.t-select--sm)',
    '.t-btn--sm, .t-iconbtn, .t-input--sm, .t-select--sm',
    '.t-label',
  ]) {
    const byParent = new Map()
    for (const e of d.querySelectorAll(sel)) {
      if (!vis(e) || !e.parentElement) continue
      if (!byParent.has(e.parentElement)) byParent.set(e.parentElement, [])
      byParent.get(e.parentElement).push(e)
    }
    for (const [p, group] of byParent) {
      if (group.length < 2) continue
      const cs = getComputedStyle(p)
      if (!cs.display.includes('flex') && !cs.display.includes('grid')) continue
      if (cs.display.includes('flex') && cs.flexDirection.startsWith('column')) continue
      const hs = group.map((e) => e.getBoundingClientRect().height)
      const min = Math.min(...hs), max = Math.max(...hs)
      const wrapped = group.some((e, i) => hs[i] > 1.6 * parseFloat(getComputedStyle(e).lineHeight || '0'))
      if (max - min > 1.5 && !wrapped) rows.push(`${min.toFixed(1)} vs ${max.toFixed(1)} in ${name(p)}`)
    }
  }

  const r = d.getBoundingClientRect()

  // While a modal is open the page behind it must not scroll: the platform
  // makes the rest of the document inert, but inert does not stop a scroll
  // gesture, and on a phone that gesture moved the page instead of the dialog.
  const shell = []
  // On a phone the box behind the modal is <main>, not the document - the shell
  // scrolls there, so locking `html` alone would leave the gesture working.
  const behind = document.querySelector('.app-shell > main')
  const scrolls = (e) => ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) && e.scrollHeight - e.clientHeight > 1
  if (getComputedStyle(document.documentElement).overflow !== 'hidden')
    shell.push('the page behind the modal is still scrollable')
  if (behind && scrolls(behind)) shell.push('<main> behind the modal is still scrollable')
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
    shell.push(`the page behind the modal scrolls sideways by ${document.documentElement.scrollWidth - document.documentElement.clientWidth}px`)

  // The dialog never scrolls itself, so a dialog taller than its cap owes the
  // user a scroll container inside - otherwise overflow:hidden cuts the rest
  // off and there is no gesture that brings it back. Checked here rather than
  // above because it is the opposite failure: not a stray scrollbar, but a
  // missing one.
  if (dOver.y > 2 && !dScrolls) {
    const inner = [...d.querySelectorAll('*')].some(
      (e) => vis(e) && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) && e.scrollHeight - e.clientHeight > 2,
    )
    if (!inner) shell.push(`content is ${dOver.y}px taller than the dialog and nothing inside it scrolls`)
  }

  // A sheet sits on the bottom edge and stops short of the top: the strip of
  // page still showing is what makes it a sheet rather than a takeover, and it
  // is the backdrop the user taps to get out. A sheet that fills the screen has
  // lost both.
  const sheet = d.classList.contains('dialog-sheet') && matchMedia('(max-width: 40rem)').matches
  if (sheet) {
    if (Math.abs(r.width - innerWidth) > 1) shell.push(`sheet is ${Math.round(r.width)}px wide of ${innerWidth}`)
    if (Math.abs(r.bottom - innerHeight) > 1) shell.push(`sheet does not sit on the bottom edge: ${Math.round(r.bottom)} of ${innerHeight}`)
    const shown = Math.round(innerHeight - r.height)
    if (shown < innerHeight * 0.05) shell.push(`sheet leaves only ${shown}px of the page visible - nothing to tap to dismiss`)
    if (r.height < innerHeight * 0.4) shell.push(`sheet opens to only ${Math.round(r.height)}px of ${innerHeight}`)
    // the pull needs a single-tap alternative beside it (WCAG 2.2 SC 2.5.1 /
    // 2.5.7); the grabber is it, and a second one would only be two controls
    // with the same name
    const closers = [...d.querySelectorAll('button[aria-label]')].filter((b) => vis(b) && /schließen|close/i.test(b.getAttribute('aria-label')))
    if (closers.length !== 1) shell.push(`sheet has ${closers.length} close buttons, expected exactly 1`)
  }

  return {
    title: (d.querySelector('h2, h3, [id]')?.textContent || '').trim().slice(0, 40),
    fitsViewport: r.height <= innerHeight + 1,
    sheet,
    scroll, targets, rows, shell,
  }
}

const run = async (browserName, type) => {
  const browser = await launch(type)
  const found = []
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    // the app follows the OS scheme unless a choice is stored: WS_THEME=dark runs the dark look
    // no service worker and no motion, for the reasons e2e.mjs gives
    const ctx = await browser.newContext({
      ...vp,
      colorScheme: process.env.WS_THEME === 'dark' ? 'dark' : 'light',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
      locale: LANG === 'en' ? 'en-US' : 'de-DE',
    })
    // the app keeps the language it was last shown in: set it before it reads it
    await ctx.addInitScript((l) => localStorage.setItem('weebsync.locale', l), LANG)
    const page = await ctx.newPage()
    await signIn(ctx, page, BASE)
    for (const { route, names, setup, label, role = 'button', css } of TRIGGERS) {
      await page.goto(BASE + route, { waitUntil: 'load' })
      // long enough for the list requests behind a route to land: a row action
      // that is not on the page yet reads exactly like a dialog that does not
      // exist, and that is the failure mode this whole script exists to catch
      await page.waitForTimeout(1500)
      if (setup && !(await setup(page))) continue
      for (const re of names) {
        // a menu entry is an option, not a button: the trigger says so
        const btn = css
          ? page.locator(css).filter({ visible: true }).first()
          : page.getByRole(role, { name: re }).first()
        // wait for the control rather than for a round number of milliseconds:
        // a row action that the list has not rendered yet is indistinguishable
        // from one that does not exist, and the coverage report below would
        // blame the trigger for what was only a slow request
        try {
          await btn.waitFor({ state: 'visible', timeout: 5000 })
          await btn.click({ timeout: 3000 })
        } catch {
          continue
        }
        await page.waitForTimeout(500)
        const r = await page.evaluate(auditDialog)
        if (r) {
          const layout = await scanLayout(page, 'dialog[open]')
          found.push({ browser: browserName, viewport: vpName, route: label ? `${route} (${label})` : route, trigger: String(re), ...r, layout })
        }
        await page.keyboard.press('Escape')
        await page.waitForTimeout(400)
      }
    }
    await ctx.close()
  }
  await browser.close()
  return found
}

const engines = { chromium, firefox }
const all = []
for (const b of BROWSERS) all.push(...(await run(b, engines[b])))
let bad = 0
for (const d of all) {
  const p = []
  const lay = d.layout
  if (lay.overlaps.length) p.push(`${lay.overlaps.length}x text over text`)
  if (lay.escapes.length) p.push(`${lay.escapes.length}x text escapes its box`)
  if (lay.clipped.length) p.push(`${lay.clipped.length}x text clipped`)
  if (d.scroll.length) p.push(`${d.scroll.length}x scrollbar`)
  if (d.targets.length) p.push(`${d.targets.length}x target size`)
  if (d.rows.length) p.push(`${d.rows.length}x mixed heights in a row`)
  if (!d.fitsViewport) p.push('taller than the viewport')
  if (d.shell?.length) p.push(`${d.shell.length}x modal behaviour`)
  if (p.length) {
    bad++
    console.log(`✗ ${d.browser}/${d.viewport} ${d.route} "${d.title}"${d.sheet ? ' [sheet]' : ''}: ${p.join(' · ')}`)
    for (const o of lay.overlaps.slice(0, 6)) console.log(`    overlap ${o.w}x${o.h}px "${o.a}" (${o.ae}) / "${o.b}" (${o.be})`)
    for (const o of lay.escapes.slice(0, 6)) console.log(`    escapes ${o.box} by ${o.dx}/${o.dy}px: "${o.text}"`)
    for (const o of lay.clipped.slice(0, 6)) console.log(`    clipped by ${o.by}: "${o.text}" (${o.el})`)
    for (const s of d.shell || []) console.log(`    modal ${s}`)
    for (const s of d.scroll) console.log(`    scroll ${JSON.stringify(s)}`)
    for (const t of d.targets.slice(0, 4)) console.log(`    target ${t}`)
    for (const r of d.rows.slice(0, 4)) console.log(`    height ${r}`)
  }
}
// how many of the runs actually exercised the phone sheet - a silent zero here
// would mean the sheet checks never ran, not that they passed
const sheets = all.filter((d) => d.sheet).length
// ...and which dialog was reached where. A trigger that silently never fired -
// a row action that needs data, a nested dialog whose parent did not open -
// leaves a gap here instead of passing as a clean run.
const cover = new Map()
for (const d of all) {
  const k = `${d.route} ${d.trigger}`
  if (!cover.has(k)) cover.set(k, [])
  cover.get(k).push(`${d.browser[0]}/${d.viewport}`)
}
console.log('\nCoverage:')
for (const [k, where] of cover) console.log(`  ${where.length}x ${k} - ${where.join(' ')}`)
// a trigger nobody ever hit is a finding, not a pass: a renamed button (the
// English label drifting away from the German one, say) would otherwise turn
// the whole dialog invisible to this script and still report a clean run.
// Only a trigger that needs data the instance may not have is let off, and
// it is still listed with what it needs.
const never = []
for (const { route, names, label, optional } of TRIGGERS)
  for (const re of names) {
    if (cover.has(`${label ? `${route} (${label})` : route} ${String(re)}`)) continue
    if (optional) console.log(`- skipped ${route} ${re}: needs ${optional}`)
    else never.push(`${route} ${re}`)
  }
for (const n of never) console.log(`✗ trigger never fired: ${n}`)
console.log(
  bad === 0 && !never.length
    ? `\n✓ ${all.length} dialogs checked (${sheets} of them as a sheet): no findings`
    : `\n${bad}/${all.length} dialogs with findings, ${never.length} dead triggers (${sheets} checked as a sheet)`,
)
if (bad || never.length) process.exitCode = 1
