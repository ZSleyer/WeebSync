// End-to-end pass over the running app: every route, in Chromium and Firefox,
// at desktop, Pixel 8 Pro and iPhone 14. Checks what a screenshot cannot - WCAG
// 2.2 AA text contrast (1.4.3) and target size (2.5.8), console errors, control
// heights per family, labels that wrapped, and whether the mobile shell stays
// pinned - and leaves one screenshot per route/browser/viewport behind.
//
//   node .ds-sync/e2e.mjs [--base http://127.0.0.1:8099] [--out ./e2e-shots] [--tag before]
import { chromium, firefox } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8099')
const OUT = arg('out', './e2e-shots')
const TAG = arg('tag', '')
// Two ways in, because the test DB may be OIDC-only: a session token handed in
// via WS_TOKEN (inserted straight into the sessions table) wins, otherwise the
// password login of a local account.
const TOKEN = process.env.WS_TOKEN || ''
const LOGIN = { email: 'a@example.com', password: 'testpassword123' }

const ROUTES = arg('routes', '').split(',').filter(Boolean).length
  ? arg('routes', '').split(',')
  : [
  '/', '/local', '/remote', '/watches', '/suggestions', '/servers', '/rename',
  '/settings/look', '/settings/account', '/settings/notifications', '/settings/about',
  '/settings/transfers', '/settings/security', '/settings/integrations',
  '/settings/email', '/settings/users', '/settings/jobs', '/settings/import',
]

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  // Pixel 8 Pro as Chrome reports it
  pixel: { viewport: { width: 448, height: 998 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  // iPhone 14 - the narrower of the two target phones, and therefore the one
  // that finds the labels which no longer fit on a single line
  iphone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
}

// Runs in the page. Walks every text node for contrast and every interactive
// element for target size, and collects one height per control family.
const audit = () => {
  const lum = (c) => {
    const m = (c.match(/[\d.]+/g) || ['0', '0', '0']).map(Number)
    if (m.length >= 4 && m[3] === 0) return null // fully transparent
    const [r, g, b] = m.slice(0, 3).map((v) => {
      v /= 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const bgOf = (el) => {
    let n = el
    while (n) {
      const b = getComputedStyle(n).backgroundColor
      if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') return b
      n = n.parentElement
    }
    return getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)'
  }
  const ratio = (fg, bg) => {
    const l1 = lum(fg), l2 = lum(bg)
    if (l1 === null || l2 === null) return 21
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  const visible = (el) => {
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  const contrast = []
  for (const el of document.querySelectorAll('body *')) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('')
    if (!own || !visible(el)) continue
    const cs = getComputedStyle(el)
    const size = parseFloat(cs.fontSize)
    const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700)
    const r = ratio(cs.color, bgOf(el))
    if (r < (large ? 3 : 4.5)) contrast.push({ text: own.slice(0, 40), size: +size.toFixed(1), ratio: +r.toFixed(2) })
  }

  const targets = []
  for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="option"], [role="tab"], [tabindex]:not([tabindex="-1"])')) {
    if (!visible(el) || el.disabled) continue
    const cs = getComputedStyle(el)
    // visually hidden control behind a visible label (file inputs): the label
    // carries the target, this element is not the hit area
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') continue
    // 2.5.8 exempts a link inline in a sentence
    if (el.tagName === 'A' && cs.display.startsWith('inline')) continue
    const b = el.getBoundingClientRect()
    if (b.width < 24 || b.height < 24)
      targets.push({ tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 30), w: +b.width.toFixed(1), h: +b.height.toFixed(1) })
  }

  // Heights are compared PER ROW, not per page: a small button sitting next to
  // a full-height input is supposed to stretch to that input, and a page-wide
  // comparison would flag exactly the alignment we want. Two controls of the
  // same family under the same parent, however, must agree.
  const heights = {}
  const offenders = {}
  const label = (e) =>
    `${e.tagName.toLowerCase()}.${e.className.toString().slice(0, 50)} "${(e.textContent || '').trim().slice(0, 20)}"`
  for (const [family, sel] of Object.entries({
    // a textarea is multi-line by definition, so its height says nothing about
    // whether the single-line controls agree
    full: '.t-btn:not(.t-btn--sm), .t-input:not(.t-input--sm):not(textarea), .t-select:not(.t-select--sm)',
    small: '.t-btn--sm, .t-iconbtn, .t-input--sm, .t-select--sm',
    badge: '.t-label',
  })) {
    const els = [...document.querySelectorAll(sel)].filter((e) => visible(e))
    if (els.length) heights[family] = [...new Set(els.map((e) => +e.getBoundingClientRect().height.toFixed(1)))].sort((a, b) => a - b)
    const rows = new Map()
    for (const e of els) {
      const p = e.parentElement
      if (!p) continue
      if (!rows.has(p)) rows.set(p, [])
      rows.get(p).push(e)
    }
    const bad = []
    for (const [p, group] of rows) {
      if (group.length < 2) continue
      const cs = getComputedStyle(p)
      // only a row: siblings stacked vertically are allowed to differ
      if (!cs.display.includes('flex') && !cs.display.includes('grid')) continue
      if (cs.display.includes('flex') && cs.flexDirection.startsWith('column')) continue
      const hs = group.map((e) => ({ h: +e.getBoundingClientRect().height.toFixed(1), e }))
      const min = Math.min(...hs.map((x) => x.h)), max = Math.max(...hs.map((x) => x.h))
      // a chip that wrapped to two lines is content, not a size mismatch
      const wrapped = hs.some((x) => x.h > 1.6 * parseFloat(getComputedStyle(x.e).lineHeight || '0'))
      if (max - min > 1.5 && !wrapped)
        bad.push({ h: max, n: group.length, sample: `${min}px vs ${max}px in ${label(p)} -> ${label(hs.find((x) => x.h === max).e)}` })
    }
    if (bad.length) offenders[family] = bad
  }

  // Scrollbars that should not be there: the page scrolling sideways, or a
  // container that declares overflow and then overflows by a hair - the classic
  // symptom of a wrapper one padding step too small.
  const scroll = []
  const doc = document.documentElement
  if (doc.scrollWidth > doc.clientWidth + 1)
    scroll.push({ where: 'document', axis: 'x', overflow: doc.scrollWidth - doc.clientWidth })
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    const scrolls = (a) => ['auto', 'scroll'].includes(a)
    // a deliberately styled scroller (scrollbar hidden, fade indicators) is a
    // design decision, not a stray bar - the tab strip on phones
    if (cs.scrollbarWidth === 'none') continue
    if (scrolls(cs.overflowX) && el.scrollWidth > el.clientWidth + 1)
      scroll.push({ where: el.className?.toString().slice(0, 40) || el.tagName, axis: 'x', overflow: el.scrollWidth - el.clientWidth })
    // The mirror image, and the one that hides best: a row too narrow for its
    // children that declares no overflow at all. Nothing scrolls, no bar
    // appears, and the document can still measure clean - the content just
    // hangs over the edge of its card, which is how a catalogue tile came to
    // draw its fourth button outside the panel.
    else if (cs.overflowX === 'visible' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
      scroll.push({ where: el.className?.toString().slice(0, 40) || el.tagName, axis: 'x', overflow: el.scrollWidth - el.clientWidth, hangs: true })
    // a vertical overflow of a few pixels is a layout slip, not real content
    if (scrolls(cs.overflowY)) {
      const over = el.scrollHeight - el.clientHeight
      if (over > 1 && over <= 8)
        scroll.push({ where: el.className?.toString().slice(0, 40) || el.tagName, axis: 'y', overflow: over })
    }
  }

  // Labels that had to break across lines to fit. A button or a chip is a
  // single-line control by design, so a second line means the box is too narrow
  // for its text - the exact regression the mobile scale-up produced. Counting
  // box height would lie here: an inline icon has a client rect of its own, and
  // a stretched flex item is tall without its text wrapping. So the line boxes
  // of the TEXT NODES are counted instead.
  const lineCount = (el) => {
    const tops = new Set()
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.nodeValue.trim()) continue
      const rng = document.createRange()
      rng.selectNodeContents(n)
      // quarter-pixel buckets: sub-pixel jitter must not read as a new line
      for (const r of rng.getClientRects()) if (r.width > 1) tops.add(Math.round(r.top / 4))
    }
    return tops.size
  }
  const wrapped = []
  for (const el of document.querySelectorAll('.t-label, .t-btn, .t-tab')) {
    if (!visible(el)) continue
    // a chip that is prose, not a chip - a page subtitle or a status line with
    // a server name in it - says so, and is allowed the second line
    if (el.classList.contains('t-label--multiline')) continue
    const n = lineCount(el)
    if (n < 2) continue
    // how wide the label would have to be to fit on one line. Measured on a
    // detached clone, because a wrapped element's scrollWidth equals its
    // clientWidth and says nothing about what it needed.
    const clone = el.cloneNode(true)
    clone.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;flex:none;width:auto;min-width:0'
    el.parentElement.appendChild(clone)
    const needs = Math.ceil(clone.getBoundingClientRect().width)
    clone.remove()
    wrapped.push({ text: (el.textContent || '').trim().slice(0, 45), lines: n, w: Math.round(el.getBoundingClientRect().width), needs })
  }

  // The mobile shell: the tab bar is pinned to the bottom of the viewport and
  // the header to the top, before and after a scroll. A page that is barely
  // taller than the viewport ("phantom overflow") is the other half of the same
  // bug - it is what makes a phone's URL bar toggle on every gesture.
  const shell = []
  // `visible` matters: on desktop both are display:none but keep their
  // position, and a zero-size rect would read as "pinned 900px too high"
  const nav = [...document.querySelectorAll('nav')].find((n) => visible(n) && getComputedStyle(n).position === 'fixed')
  const header = [...document.querySelectorAll('header')].find((h) => visible(h) && getComputedStyle(h).position === 'sticky')
  const check = (when) => {
    if (nav) {
      const b = nav.getBoundingClientRect().bottom
      if (Math.abs(b - innerHeight) > 1) shell.push({ what: 'tab bar not at the viewport bottom', when, off: Math.round(b - innerHeight) })
    }
    if (header) {
      const t = header.getBoundingClientRect().top
      if (Math.abs(t) > 1) shell.push({ what: 'header not flush with the top', when, off: Math.round(t) })
    }
  }
  check('at rest')
  const y0 = scrollY
  scrollTo(0, 400)
  check('after scrolling')
  scrollTo(0, y0)
  const phantom = doc.scrollHeight - innerHeight
  if (phantom > 0 && phantom <= 24) shell.push({ what: 'phantom overflow - the page scrolls without content to scroll', off: phantom })

  // The other half of that check, and the one whose absence reads as success:
  // a page whose content the user cannot reach. A flex child that may shrink
  // below its content keeps <main> from growing, so the document reports no
  // overflow at all - zero phantom overflow and zero scrolling look identical
  // from the outside. Compare the deepest content against what the document
  // admits to being tall, and confirm the scroll actually goes that far.
  let deepest = 0
  let who = null
  // content inside a scroll container of its own is reachable there, and the
  // file browsers are built that way: the page stays the height of the screen
  // and the list scrolls. Measuring their rows against the document would
  // report every row below the fold as lost.
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== doc; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (['auto', 'scroll'].includes(cs.overflowY) || ['auto', 'scroll'].includes(cs.overflowX)) return true
    }
    return false
  }
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.position === 'fixed') continue
    if (inScroller(el)) continue
    const r = el.getBoundingClientRect()
    if (!r.height) continue
    const b = r.bottom + scrollY
    if (b > deepest) {
      deepest = b
      who = el.tagName.toLowerCase() + '.' + el.className.toString().slice(0, 40)
    }
  }
  const unreachable = Math.round(deepest - doc.scrollHeight)
  if (unreachable > 1) shell.push({ what: `content below the scrollable area (${who})`, off: unreachable })
  if (doc.scrollHeight > innerHeight + 1) {
    scrollTo(0, doc.scrollHeight)
    const reached = scrollY
    scrollTo(0, y0)
    const short = Math.round(doc.scrollHeight - innerHeight - reached)
    if (short > 2) shell.push({ what: 'the page stops scrolling before its end', off: short })
  }
  if (getComputedStyle(doc).overflow === 'hidden' && !document.querySelector('dialog[open]'))
    shell.push({ what: 'the page is locked against scrolling with no modal open', off: 0 })

  return { contrast, targets, heights, offenders, scroll, wrapped, shell, title: document.title }
}

const run = async (name, browserType) => {
  const browser = await browserType.launch()
  const findings = []
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext(vp)
    const page = await ctx.newPage()
    const errors = []
    // a navigation aborts the app's open SSE streams; that is expected noise
    // 2152398850 = 0x804b0002 = NS_BINDING_ABORTED: Firefox reports a font whose
    // download the next navigation cut short, which is the harness, not the app
    const noise = /was interrupted while the page was loading|NS_BINDING_ABORTED|net::ERR_ABORTED|Failed to load resource.*events|downloadable font.*2152398850/i
    page.on('console', (m) => m.type() === 'error' && !noise.test(m.text()) && errors.push(m.text().slice(0, 160)))
    page.on('pageerror', (e) => !noise.test(e.message) && errors.push('pageerror: ' + e.message.slice(0, 160)))

    if (TOKEN) {
      const u = new URL(BASE)
      await ctx.addCookies([
        { name: 'weebsync_session', value: TOKEN, domain: u.hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
      ])
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
    } else {
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
      await page.evaluate(async (l) => {
        await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(l) })
      }, LOGIN)
    }

    // The catalogue is a view, not a route: a plain /remote shows the classic
    // list, so the tile grid - the densest layout in the app, and the one whose
    // buttons hung over the card edge - was never in this sweep. Ask the API
    // for a folder that actually matched a title instead of hardcoding a path
    // out of somebody's library.
    const extra = await page.evaluate(async () => {
      const servers = await (await fetch('/api/servers', { credentials: 'include' })).json()
      const queue = servers.map((s) => ({ id: s.id, path: '' }))
      for (let i = 0; i < 8 && queue.length; i++) {
        const { id, path } = queue.shift()
        const r = await fetch(`/api/servers/${id}/catalog${path ? `?path=${encodeURIComponent(path)}` : ''}`, { credentials: 'include' })
        if (!r.ok) continue
        const items = (await r.json()).items || []
        if (items.some((it) => it.media)) return `/remote?server=${id}&path=${encodeURIComponent(path.replace(/^\//, ''))}`
        for (const it of items) queue.push({ id, path: it.entry.path })
      }
      return null
    }).catch(() => null)

    for (const route of [...ROUTES, ...(extra ? [extra] : [])]) {
      errors.length = 0
      // not networkidle: the app keeps an SSE stream open, so it never idles
      await page.goto(BASE + route, { waitUntil: 'load' })
      await page.waitForTimeout(600)
      const r = await page.evaluate(audit)
      const slug = route.replace(/[^\w-]+/g, '_') || '_root'
      const file = `${OUT}/${TAG ? TAG + '-' : ''}${name}-${vpName}${slug}.png`
      // a full-page shot is capped at 32767 device px; long lists on the real
      // test data blow past that, so clip instead of failing the whole run
      const maxCss = Math.floor(32000 / (vp.deviceScaleFactor || 1))
      const docH = await page.evaluate(() => document.documentElement.scrollHeight)
      await page.screenshot(
        docH > maxCss
          ? { path: file, clip: { x: 0, y: 0, width: vp.viewport.width, height: maxCss } }
          : { path: file, fullPage: true },
      )
      findings.push({ browser: name, viewport: vpName, route, ...r, errors: [...new Set(errors)], shot: file })
    }
    await ctx.close()
  }
  await browser.close()
  return findings
}

mkdirSync(OUT, { recursive: true })
const all = [...(await run('chromium', chromium)), ...(await run('firefox', firefox))]
writeFileSync(`${OUT}/${TAG ? TAG + '-' : ''}report.json`, JSON.stringify(all, null, 2))

let bad = 0
for (const f of all) {
  const problems = []
  if (f.contrast.length) problems.push(`${f.contrast.length}x Kontrast (min ${Math.min(...f.contrast.map((c) => c.ratio))}:1)`)
  if (f.targets.length) problems.push(`${f.targets.length}x Zielgröße`)
  if (f.errors.length) problems.push(`${f.errors.length}x Konsolenfehler`)
  if (f.scroll?.length) problems.push(`${f.scroll.length}x Scrollbalken`)
  if (f.wrapped?.length) problems.push(`${f.wrapped.length}x Label umgebrochen`)
  if (f.shell?.length) problems.push(`${f.shell.length}x Shell verrutscht`)
  for (const [fam, rows] of Object.entries(f.offenders || {})) problems.push(`${fam}: ${rows.length}x Höhen in einer Zeile uneinheitlich`)
  if (problems.length) {
    bad++
    console.log(`✗ ${f.browser}/${f.viewport} ${f.route}: ${problems.join(' · ')}`)
    for (const c of f.contrast.slice(0, 4)) console.log(`    Kontrast ${c.ratio}:1 ${c.size}px "${c.text}"`)
    for (const t of f.targets.slice(0, 4)) console.log(`    Ziel ${t.w}x${t.h} <${t.tag}> "${t.text}"`)
    for (const sc of (f.scroll || []).slice(0, 4)) console.log(`    Scroll ${sc.axis} +${sc.overflow}px in "${sc.where}"`)
    for (const w of (f.wrapped || []).slice(0, 6)) console.log(`    Umbruch ${w.lines} Zeilen: ${w.w}px vorhanden, ${w.needs}px nötig "${w.text}"`)
    for (const s of (f.shell || []).slice(0, 4)) console.log(`    Shell ${s.what}${s.when ? ` (${s.when})` : ''}: ${s.off}px`)
    for (const [fam, rows] of Object.entries(f.offenders || {}))
      for (const r of rows) console.log(`    ${fam} ${r.h}px x${r.n}  ${r.sample}`)
    for (const e of f.errors.slice(0, 3)) console.log(`    ${e}`)
  }
}
console.log(bad === 0
  ? `\n✓ ${all.length} Seitenläufe (2 Browser x ${Object.keys(VIEWPORTS).length} Viewports x ${new Set(all.map((r) => r.route)).size} Routen): keine Befunde`
  : `\n${bad}/${all.length} Seitenläufe mit Befunden`)
