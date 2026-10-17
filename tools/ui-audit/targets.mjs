// Touch-target pass: loads the main routes on a coarse-pointer phone and lists
// every visible interactive element whose hit box is under 24px (WCAG 2.2 AA
// 2.5.8) and, separately, under 44px (the touch comfort size), plus every
// focusable field that would make iOS zoom in (computed font-size under 16px).
// The hit box includes an absolutely positioned ::before/::after (the way the
// design system grows a small control's area without changing how it looks).
//
//   WS_TOKEN=... node tools/ui-audit/targets.mjs [--base http://127.0.0.1:8090] [--viewports iphone,phone] [--routes /a,/b] [--groups] [--json out.json]
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
import { signIn } from './auth.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8090')
const ROUTES = (
  arg('routes', '') ||
  [
    '/', '/files', '/files?source=local', '/history', '/watches', '/watches?view=calendar', '/watches?layout=grid',
    '/discover/merkliste', '/discover/empfohlen', '/discover/trending', '/discover/upgrades', '/discover/unvollstaendig',
    '/discover/duplikate', '/discover/assistent', '/rename', '/rules',
    '/settings', '/settings/general', '/settings/about', '/settings/account', '/settings/sync', '/settings/notifications',
    '/settings/servers', '/settings/transfers', '/settings/security', '/settings/integrations', '/settings/jobs',
    '/settings/matching', '/settings/data',
  ].join(',')
).split(',')
const VPS = {
  iphone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  phone: { viewport: { width: 448, height: 998 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
}
const vps = arg('viewports', 'iphone,phone').split(',')

const SEL =
  'button, a[href], [role=button], [role=menuitem], [role=menuitemradio], [role=tab], [role=switch], [role=option], input:not([type=hidden]), select, textarea, summary'

const measure = (sel) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0
  }
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
  const name = (el) => {
    const cls = (el.getAttribute('class') || '')
      .split(/\s+/)
      .filter((c) => c.startsWith('t-'))
      .slice(0, 2)
      .join('.')
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`
  }
  const out = { small: [], mid: [], zoom: [] }
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el) || el.disabled) continue
    const cs = getComputedStyle(el)
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') continue
    // a visually hidden control behind a visible label: the label is the target
    if (el.tagName === 'INPUT' && el.labels?.length && (el.getBoundingClientRect().width <= 1 || cs.opacity === '0')) continue
    // 2.5.8 exempts a link inline in a sentence
    if (el.tagName === 'A' && cs.display.startsWith('inline')) continue
    const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 28)
    const b = hitBox(el)
    const rec = { el: name(el), label, w: +b.width.toFixed(1), h: +b.height.toFixed(1) }
    if (b.width < 24 || b.height < 24) out.small.push(rec)
    else if (b.width < 43.5 || b.height < 43.5) out.mid.push(rec)
    if (
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) &&
      !['checkbox', 'radio', 'range', 'file', 'button', 'submit', 'color'].includes(el.type)
    ) {
      const fs = parseFloat(cs.fontSize)
      if (fs < 16) out.zoom.push({ el: name(el), label, fs })
    }
  }
  return out
}

const browser = await chromium.launch()
const result = {}
for (const vpName of vps) {
  const ctx = await browser.newContext({ ...VPS[vpName], locale: 'de-DE' })
  const page = await ctx.newPage()
  await signIn(ctx, page, BASE)
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches).catch(() => 'n/a')
  console.log(`\n## ${vpName} ${VPS[vpName].viewport.width}x${VPS[vpName].viewport.height} pointer:coarse=${coarse}`)
  let small = 0
  let mid = 0
  let zoom = 0
  const uniq = { small: new Map(), mid: new Map(), zoom: new Map() }
  for (const route of ROUTES) {
    await page.goto(BASE + route, { waitUntil: 'load' })
    await page.waitForTimeout(700)
    const r = await page.evaluate(measure, SEL)
    small += r.small.length
    mid += r.mid.length
    zoom += r.zoom.length
    for (const k of ['small', 'mid', 'zoom'])
      for (const x of r[k]) {
        const key = k === 'zoom' ? `${x.el} ${x.fs}px` : `${x.el} ${x.w}x${x.h}`
        const e = uniq[k].get(key) || { n: 0, routes: new Set(), label: x.label }
        e.n++
        e.routes.add(route)
        uniq[k].set(key, e)
      }
    console.log(
      `${route.padEnd(30)} <24: ${String(r.small.length).padStart(3)}  24-44: ${String(r.mid.length).padStart(3)}  zoom<16: ${r.zoom.length}`,
    )
  }
  console.log(`TOTAL ${vpName}: <24=${small} 24-44=${mid} zoom<16=${zoom}`)
  const groups = {}
  for (const [k, m] of Object.entries(uniq))
    groups[k] = [...m]
      .map(([key, e]) => ({ key, n: e.n, label: e.label, routes: [...e.routes].slice(0, 4) }))
      .sort((a, b) => b.n - a.n)
  result[vpName] = { small, mid, zoom, groups }
  if (process.argv.includes('--groups'))
    for (const k of ['small', 'mid', 'zoom']) {
      console.log(`-- ${k}`)
      for (const g of groups[k].slice(0, 40)) console.log(`  ${String(g.n).padStart(3)}x ${g.key}  "${g.label}"  ${g.routes.join(' ')}`)
    }
  await ctx.close()
}
await browser.close()
if (arg('json', '')) writeFileSync(arg('json', ''), JSON.stringify(result, null, 2))
