// Opens every dialog the app has and audits it the way e2e.mjs audits a page:
// control heights per row, target size, and above all scrollbars - a modal is
// where a stray one hurts most, and a page-level pass never sees it because the
// dialog is not in the DOM until something is clicked.
//
//   node .ds-sync/modals.mjs [--base http://127.0.0.1:8080]
import { chromium, firefox } from 'playwright'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:8080')
const TOKEN = process.env.WS_TOKEN || ''

// route -> the controls that open a dialog there, by accessible name. `setup`
// runs first for views that are not the route's default - the catalogue on
// /remote is a separate view with dialogs of its own, and a plain visit never
// reaches it.
const TRIGGERS = [
  { route: '/servers', names: [/Server hinzufügen|Add server/, /Bearbeiten|^Edit$/, /Löschen|^Delete$/] },
  { route: '/watches', names: [/Bearbeiten|^Edit$/, /Löschen|^Delete$/, /fehlt$|Lücken:|gaps:|missing$/] },
  {
    // nested: the Plex picker only exists inside the watch dialog, so the
    // parent has to be open before the trigger is on the page at all
    route: '/watches',
    label: 'Plex-Serie',
    setup: async (page) => {
      const edit = page.getByRole('button', { name: /Bearbeiten|^Edit$/ }).first()
      if (!(await edit.count().catch(() => 0))) return false
      await edit.click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(900)
      return (await page.getByRole('button', { name: /^Ändern$|^Change$/ }).count().catch(() => 0)) > 0
    },
    names: [/^Ändern$|^Change$/],
  },
  // the app's prompt() replacement - a dialog of its own, and the only one
  // reached from a per-row action rather than a page-level button
  { route: '/local', label: 'Prompt', names: [/umbenennen$|^Rename /] },
  // /remote itself has no dialog of its own - the file list is a view, not a
  // modal, and every modal on that route lives in the catalogue below
  {
    route: '/remote',
    label: 'Katalog',
    setup: async (page) => {
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
      if (target) {
        await page.goto(`${BASE}/remote?server=${target.id}&path=${encodeURIComponent(target.path.replace(/^\//, ''))}`)
        await page.waitForTimeout(2500)
      }
      // the view picker is gone once a folder is saved as a catalogue folder,
      // which is exactly the state a previous run leaves behind
      const view = page.getByRole('combobox', { name: /Ansicht|View/ }).first()
      if (await view.count().catch(() => 0)) {
        await view.selectOption({ index: 2 }) // catalogue, persisted
        await page.waitForTimeout(2500)
      }
      return (await page.getByRole('article').count().catch(() => 0)) > 0
    },
    names: [/Details zu|Details for/, /Match ändern|Change match/, /Syncen|Sync/],
  },
  { route: '/suggestions', names: [/Ignorierte|Ignored/] },
  // the reset dialog is the widest one in the app: it lists every data store as
  // a chip, and the longest of those labels is what a phone has to fit
  // `Ansehen` opens the cache viewer (a list dialog), `Index leeren` the
  // confirm box, and the reset dialog is the widest one in the app
  { route: '/settings/jobs', names: [/^Ansehen$|^View$/, /^Index leeren$|^Flush index$/, /Alles neu aufbauen|Rebuild everything/] },
]

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
  pixel: { viewport: { width: 448, height: 998 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  iphone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
}

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
  if (dScrolls && (dOver.y > 0 || dOver.x > 0)) scroll.push({ where: 'dialog selbst', ...dOver })
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
    scroll.push({ where: `dialog steht ${Math.round(Math.max(dr.right - innerWidth, -dr.left))}px über dem Viewport`, x: Math.round(Math.max(dr.right - innerWidth, -dr.left)) })
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
  if (out > 1) scroll.push({ where: `${widest} ragt ${out}px über den Dialog hinaus`, x: out })

  // target size 2.5.8
  const targets = []
  for (const e of d.querySelectorAll('a[href], button, input, select, textarea')) {
    if (!vis(e) || e.disabled) continue
    const cs = getComputedStyle(e)
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') continue
    if (e.tagName === 'A' && cs.display.startsWith('inline')) continue
    const b = e.getBoundingClientRect()
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

  // A sheet-sized dialog covers the phone screen, so it has no backdrop left to
  // click - it owes the user exactly one visible way out.
  const sheet = d.classList.contains('dialog-sheet') && matchMedia('(max-width: 40rem)').matches
  if (sheet) {
    if (Math.abs(r.width - innerWidth) > 1 || Math.abs(r.height - innerHeight) > 1)
      shell.push(`sheet does not fill the screen: ${Math.round(r.width)}x${Math.round(r.height)} of ${innerWidth}x${innerHeight}`)
    const closers = [...d.querySelectorAll('button[aria-label]')].filter((b) => vis(b) && /schließen|close/i.test(b.getAttribute('aria-label')))
    if (closers.length !== 1) shell.push(`sheet has ${closers.length} close buttons, expected exactly 1`)
    // and the reverse of "does it fill the screen": a dialog that takes the
    // whole screen for a search box and four rows reads as broken, not as
    // deliberate. Such a dialog belongs in a centred box (sheet={false}).
    // leaves only: the boxes around the content are stretched to the sheet by
    // `height: 100%`, so measuring them would always report a full screen
    let deepest = 0
    for (const e of d.querySelectorAll('*')) {
      if (!vis(e) || e.children.length) continue
      deepest = Math.max(deepest, e.getBoundingClientRect().bottom)
    }
    const empty = Math.round(r.bottom - deepest)
    if (empty > innerHeight * 0.25) shell.push(`sheet leaves ${empty}px empty - it does not need the whole screen`)
  }

  return {
    title: (d.querySelector('h2, h3, [id]')?.textContent || '').trim().slice(0, 40),
    fitsViewport: r.height <= innerHeight + 1,
    sheet,
    scroll, targets, rows, shell,
  }
}

const run = async (browserName, type) => {
  const browser = await type.launch()
  const found = []
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext(vp)
    if (TOKEN)
      await ctx.addCookies([
        { name: 'weebsync_session', value: TOKEN, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
      ])
    const page = await ctx.newPage()
    for (const { route, names, setup, label } of TRIGGERS) {
      await page.goto(BASE + route, { waitUntil: 'load' })
      // long enough for the list requests behind a route to land: a row action
      // that is not on the page yet reads exactly like a dialog that does not
      // exist, and that is the failure mode this whole script exists to catch
      await page.waitForTimeout(1500)
      if (setup && !(await setup(page))) continue
      for (const re of names) {
        const btn = page.getByRole('button', { name: re }).first()
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
        if (r) found.push({ browser: browserName, viewport: vpName, route: label ? `${route} (${label})` : route, trigger: String(re), ...r })
        await page.keyboard.press('Escape')
        await page.waitForTimeout(400)
      }
    }
    await ctx.close()
  }
  await browser.close()
  return found
}

const all = [...(await run('chromium', chromium)), ...(await run('firefox', firefox))]
let bad = 0
for (const d of all) {
  const p = []
  if (d.scroll.length) p.push(`${d.scroll.length}x Scrollbalken`)
  if (d.targets.length) p.push(`${d.targets.length}x Zielgröße`)
  if (d.rows.length) p.push(`${d.rows.length}x Höhen in einer Zeile`)
  if (!d.fitsViewport) p.push('höher als der Viewport')
  if (d.shell?.length) p.push(`${d.shell.length}x Modal-Verhalten`)
  if (p.length) {
    bad++
    console.log(`✗ ${d.browser}/${d.viewport} ${d.route} "${d.title}"${d.sheet ? ' [sheet]' : ''}: ${p.join(' · ')}`)
    for (const s of d.shell || []) console.log(`    Modal ${s}`)
    for (const s of d.scroll) console.log(`    Scroll ${JSON.stringify(s)}`)
    for (const t of d.targets.slice(0, 4)) console.log(`    Ziel ${t}`)
    for (const r of d.rows.slice(0, 4)) console.log(`    Höhe ${r}`)
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
console.log('\nAbdeckung:')
for (const [k, where] of cover) console.log(`  ${where.length}x ${k} — ${where.join(' ')}`)
// a trigger nobody ever hit is a finding, not a pass: a renamed button (the
// English label drifting away from the German one, say) would otherwise turn
// the whole dialog invisible to this script and still report a clean run
const never = []
for (const { route, names, label } of TRIGGERS)
  for (const re of names) if (!cover.has(`${label ? `${route} (${label})` : route} ${String(re)}`)) never.push(`${route} ${re}`)
for (const n of never) console.log(`✗ Trigger nie ausgelöst: ${n}`)
console.log(
  bad === 0 && !never.length
    ? `\n✓ ${all.length} Dialoge geprüft (davon ${sheets} als Vollbild-Sheet): keine Befunde`
    : `\n${bad}/${all.length} Dialoge mit Befunden, ${never.length} Trigger tot (${sheets} als Vollbild-Sheet geprüft)`,
)
if (bad || never.length) process.exitCode = 1
