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
  { route: '/watches', names: [/Bearbeiten|^Edit$/, /Löschen|^Delete$/] },
  { route: '/remote', names: [/Details|^Detail/] },
  {
    route: '/remote',
    label: 'Katalog',
    setup: async (page) => {
      const view = page.getByRole('combobox', { name: /Ansicht|View/ }).first()
      if (!(await view.count().catch(() => 0))) return false
      await view.selectOption({ index: 2 }) // catalogue, persisted
      await page.waitForTimeout(2500)
      return true
    },
    names: [/Details zu|Details for/, /Match ändern|Change match/, /Syncen|Sync/],
  },
  { route: '/suggestions', names: [/Ignorierte|Ignored/] },
  { route: '/settings/jobs', names: [/Treffer|Matches|Cache/] },
]

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
  pixel: { viewport: { width: 448, height: 998 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  iphone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
}

const auditDialog = () => {
  const d = document.querySelector('dialog[open]')
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
  if (getComputedStyle(document.documentElement).overflow !== 'hidden')
    shell.push('the page behind the modal is still scrollable')

  // A sheet-sized dialog covers the phone screen, so it has no backdrop left to
  // click - it owes the user exactly one visible way out.
  const sheet = d.classList.contains('dialog-sheet') && matchMedia('(max-width: 40rem)').matches
  if (sheet) {
    if (Math.abs(r.width - innerWidth) > 1 || Math.abs(r.height - innerHeight) > 1)
      shell.push(`sheet does not fill the screen: ${Math.round(r.width)}x${Math.round(r.height)} of ${innerWidth}x${innerHeight}`)
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
      await page.waitForTimeout(700)
      if (setup && !(await setup(page))) continue
      for (const re of names) {
        const btn = page.getByRole('button', { name: re }).first()
        if (!(await btn.count().catch(() => 0))) continue
        try {
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
console.log(
  bad === 0
    ? `\n✓ ${all.length} Dialoge geprüft (davon ${sheets} als Vollbild-Sheet): keine Befunde`
    : `\n${bad}/${all.length} Dialoge mit Befunden (${sheets} als Vollbild-Sheet geprüft)`,
)
