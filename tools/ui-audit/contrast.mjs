// WCAG 2.2 AA contrast, measured against what is actually painted behind each
// thing rather than the nearest ancestor with a background colour (the e2e
// pass's shortcut, which misses translucent glass, opacity and text on art).
//
// - text (1.4.3): 4.5:1, 3:1 from 24px or 18.66px bold. Placeholders count.
// - non-text (1.4.11): 3:1 for icons that carry meaning on their own and for
//   the boundary of a form control against what it sits on.
// - focus indicators (1.4.11 / 2.4.13 lite): Tab through the page and measure
//   the outline (or ring) against the background next to it.
// - text over an image (a hero caption, a chip on a cover): the pixels behind
//   it are sampled from a screenshot taken with the text hidden, and the worst
//   10% decides.
//
// Disabled controls are exempt (1.4.3) and are listed apart, not failed.
//
//   WS_EMAIL=... WS_PASSWORD=... node tools/ui-audit/contrast.mjs --base http://127.0.0.1:8080 \
//     [--viewports phone,wide] [--themes dark,light] [--routes /a,/b] [--inject '<css>']
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
import { launch, signIn } from './auth.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:8080')
const ROUTES = arg('routes', '')
  ? arg('routes', '').split(',')
  : [
      '/', '/files', '/files/trash', '/history', '/watches', '/watches?view=calendar', '/watches?layout=grid',
      '/discover/merkliste', '/discover/trending', '/discover/upgrades', '/discover/unvollstaendig', '/discover/assistent',
      '/rename', '/rules', '/settings', '/settings/general', '/settings/account', '/settings/sync',
      '/settings/notifications', '/settings/servers', '/settings/security', '/settings/integrations', '/settings/jobs',
      '/settings/data',
    ]
const VP = {
  phone: { viewport: { width: 448, height: 998 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  wide: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
}
const VIEWPORTS = arg('viewports', 'phone,wide').split(',')
const THEMES = arg('themes', 'dark,light').split(',')

// in the page: everything but the image cases, which come back as rects
const measure = () => {
  for (const e of document.querySelectorAll('[data-contrast-probe]')) delete e.dataset.contrastProbe
  // any CSS colour (oklch, color-mix, color(srgb ...)) to [r, g, b, a]: the
  // canvas resolves what a regex would misread
  const ink = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const memo = new Map()
  const parse = (c) => {
    if (!c || c === 'transparent' || c === 'none') return [0, 0, 0, 0]
    if (memo.has(c)) return [...memo.get(c)]
    ink.clearRect(0, 0, 1, 1)
    ink.fillStyle = '#000'
    ink.fillStyle = c
    ink.fillRect(0, 0, 1, 1)
    const d = ink.getImageData(0, 0, 1, 1).data
    const v = [d[0], d[1], d[2], d[3] / 255]
    memo.set(c, v)
    return [...v]
  }
  const over = (top, under) => {
    const a = top[3] + under[3] * (1 - top[3])
    if (!a) return [0, 0, 0, 0]
    return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a)
  }
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const opacityOf = (el) => {
    let o = 1
    for (let e = el; e; e = e.parentElement) o *= +getComputedStyle(e).opacity
    return o
  }
  const desc = (el) => {
    const parts = []
    for (let e = el, i = 0; e && e !== document.body && i < 3; e = e.parentElement, i++) {
      const cls = [...e.classList].slice(0, 2)
      parts.unshift(e.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : ''))
    }
    return parts.join('>')
  }
  // what is painted under (x, y) below `self`: composite the stack top-down
  // until something opaque; an image or a gradient on the way makes it an
  // image case
  const backdrop = (self, x, y) => {
    const stack = document.elementsFromPoint(x, y)
    // not painted here at all: scrolled out of its box, or under a layer
    if (self.isConnected && stack[0] && !(stack[0] === self || self.contains(stack[0]) || stack[0].contains(self))) return { hidden: true }
    // an ancestor on top means the text itself is not hit (pointer-events,
    // or clipped away by a scroller it sits in): it counts only where every
    // clipping box around it lets the point through
    if (self.isConnected && stack[0] && stack[0] !== self && stack[0].contains(self)) {
      for (let e = self.parentElement; e && e !== stack[0]; e = e.parentElement) {
        const cs = getComputedStyle(e)
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
        const b = e.getBoundingClientRect()
        if (x < b.left || x > b.right || y < b.top || y > b.bottom) return { hidden: true }
      }
    }
    const layers = []
    for (const e of stack) {
      if (e !== self && self.contains(e)) continue
      if (/^(IMG|VIDEO|CANVAS|PICTURE)$/.test(e.tagName) || (e.tagName === 'svg' && e.querySelector('image'))) return { image: true }
      const cs = getComputedStyle(e)
      // a gradient is sampled like a picture: its worst stretch decides
      if (/url\(|gradient/.test(cs.backgroundImage)) return { image: true }
      const c = parse(cs.backgroundColor)
      c[3] *= opacityOf(e)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 0.999) break
    }
    let bg = parse(getComputedStyle(document.documentElement).backgroundColor)
    if (bg[3] < 1) bg = over(bg, parse(getComputedStyle(document.body).backgroundColor))
    if (bg[3] < 1) bg = over(bg, [255, 255, 255, 1])
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg)
    return { bg }
  }
  // visually hidden text (sr-only: a 1px box that clips) is read, not seen
  const srOnly = (el) => {
    for (let e = el, k = 0; e && k < 3; e = e.parentElement, k++) {
      const r = e.getBoundingClientRect()
      const cs = getComputedStyle(e)
      if ((r.width <= 1 || r.height <= 1) && cs.overflow !== 'visible') return true
      if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') return true
    }
    return false
  }
  const visible = (el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !el.closest('[aria-hidden="true"], [inert]') && !srOnly(el)
  const disabled = (el) => !!el.closest(':disabled, [aria-disabled="true"]')
  const onScreen = (r) => r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
  const text = [], exempt = [], images = [], nontext = []
  const range = document.createRange()
  const done = new Set()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement
    if (!n.data.trim() || !el || done.has(el) || /^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(el.tagName) || !visible(el)) continue
    done.add(el)
    range.selectNodeContents(n)
    const r = [...range.getClientRects()].find((q) => q.width > 2 && q.height > 2 && onScreen(q))
    if (!r) continue
    const cs = getComputedStyle(el)
    const fg = parse(cs.color)
    fg[3] *= opacityOf(el)
    if (fg[3] === 0) continue
    const size = parseFloat(cs.fontSize)
    const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700)
    const need = large ? 3 : 4.5
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1)
    const b = backdrop(el, x, y)
    if (b.hidden) continue
    const entry = { text: n.data.trim().slice(0, 40), el: desc(el), size: +size.toFixed(1), need, color: cs.color }
    if (b.image) {
      images.push({ ...entry, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, fg: fg.slice(0, 3), alpha: fg[3], id: images.length })
      el.dataset.contrastProbe = String(images.length - 1)
      continue
    }
    const ratioV = ratio(over(fg, b.bg), b.bg)
    if (ratioV < need) (disabled(el) ? exempt : text).push({ ...entry, ratio: +ratioV.toFixed(2), bg: b.bg.map(Math.round).slice(0, 3).join(',') })
  }
  // placeholders: their own colour on the field's own background
  for (const el of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    if (!visible(el) || el.value) continue
    const r = el.getBoundingClientRect()
    if (!onScreen(r) || !r.width) continue
    const pc = parse(getComputedStyle(el, '::placeholder').color)
    const b = backdrop(el, r.left + 8, r.top + r.height / 2)
    if (b.image || b.hidden) continue
    const v = ratio(over(pc, b.bg), b.bg)
    if (v < 4.5) (disabled(el) ? exempt : text).push({ text: '[placeholder] ' + el.placeholder.slice(0, 30), el: desc(el), ratio: +v.toFixed(2), need: 4.5 })
  }
  // control boundaries: the border of an input, select, checkbox or switch
  // against what is outside it (or, without a border, its fill)
  for (const el of document.querySelectorAll('input:not([type=hidden],[type=range]), select, textarea, [role=switch], [role=checkbox]')) {
    if (!visible(el) || disabled(el)) continue
    // a bare input inside a label that draws the field (a search box) is
    // bounded by that label
    let box = el
    for (let k = 0; k < 2; k++) {
      const c = getComputedStyle(box)
      if (parseFloat(c.borderLeftWidth) > 0 || parse(c.backgroundColor)[3] > 0) break
      if (box.parentElement) box = box.parentElement
    }
    const r = box.getBoundingClientRect()
    if (!onScreen(r) || r.width < 4) continue
    // under a bar or scrolled out of its box: not judged from here
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    if (!top || !(top === box || box.contains(top) || top.contains(box))) continue
    const cs = getComputedStyle(box)
    const outside = backdrop(document.createElement('i'), Math.max(r.left - 2, 0), r.top + r.height / 2)
    if (outside.image) continue
    const bw = parseFloat(cs.borderLeftWidth)
    const edge = bw > 0 ? parse(cs.borderLeftColor) : parse(cs.backgroundColor)
    edge[3] *= opacityOf(box)
    const inside = over(parse(cs.backgroundColor), outside.bg)
    // the boundary is visible if it stands out from either side (the
    // outside or the fill), whichever is the better of the two
    const vEdge = ratio(over(edge, outside.bg), outside.bg)
    const vFill = ratio(inside, outside.bg)
    const best = Math.max(vEdge, vFill)
    if (best < 3) nontext.push({ what: 'control boundary', el: desc(el), type: el.type || el.getAttribute('role'), ratio: +best.toFixed(2) })
  }
  // icons that stand alone in a button or link (no text next to them): the
  // icon is the label, 3:1
  for (const svg of document.querySelectorAll('button svg, a svg, [role=button] svg')) {
    const host = svg.closest('button, a, [role=button]')
    if (!visible(svg) || !host || disabled(host) || host.textContent.trim()) continue
    const r = svg.getBoundingClientRect()
    if (!onScreen(r) || r.width < 6) continue
    const cs = getComputedStyle(svg)
    const stroke = cs.stroke !== 'none' ? cs.stroke : cs.fill
    if (!stroke || stroke === 'none' || stroke.startsWith('url')) continue
    const fg = parse(stroke)
    fg[3] *= opacityOf(svg)
    const b = backdrop(svg, r.left + r.width / 2, r.top + r.height / 2)
    if (b.image || b.hidden) continue
    const v = ratio(over(fg, b.bg), b.bg)
    if (v < 3) nontext.push({ what: 'icon', el: desc(host), label: host.getAttribute('aria-label') || '', ratio: +v.toFixed(2) })
  }
  return { text, exempt, images, nontext }
}

// the colour pairs of the image cases: hide the text, shoot the rect, and
// hand the pixels back to the page to compute against
const imageCases = async (page, images) => {
  const out = []
  for (const im of images.slice(0, 40)) {
    const { x, y, w, h } = im.rect
    if (w < 2 || h < 2) continue
    const vp = page.viewportSize()
    const clip = { x: Math.max(0, x), y: Math.max(0, y), width: Math.min(w, vp.width - Math.max(0, x)), height: Math.min(h, vp.height - Math.max(0, y)) }
    if (clip.width < 2 || clip.height < 2) continue
    await page.evaluate((id) => {
      const el = document.querySelector(`[data-contrast-probe="${id}"]`)
      if (el) el.style.setProperty('color', 'transparent', 'important')
    }, String(im.id))
    const buf = await page.screenshot({ clip, animations: 'disabled' })
    await page.evaluate((id) => {
      const el = document.querySelector(`[data-contrast-probe="${id}"]`)
      if (el) el.style.removeProperty('color')
    }, String(im.id))
    const worst = await page.evaluate(async ({ b64, fg, alpha }) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + b64
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const g = c.getContext('2d')
      g.drawImage(img, 0, 0)
      const d = g.getImageData(0, 0, c.width, c.height).data
      const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
      const L = (r, gg, b) => 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b)
      const rs = []
      for (let i = 0; i < d.length; i += 16) {
        const bg = [d[i], d[i + 1], d[i + 2]]
        const t = fg.map((v, k) => v * alpha + bg[k] * (1 - alpha))
        const a = L(...t), b = L(...bg)
        rs.push((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05))
      }
      rs.sort((p, q) => p - q)
      return rs[Math.floor(rs.length * 0.1)]
    }, { b64: buf.toString('base64'), fg: im.fg, alpha: im.alpha })
    if (worst < im.need) out.push({ text: im.text, el: im.el, ratio: +worst.toFixed(2), need: im.need, overImage: true })
  }
  return out
}

// Tab through the first focusable controls and measure the indicator
const focusRing = async (page, n = 25) => {
  const bad = []
  await page.evaluate(() => document.activeElement?.blur())
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab')
    // a ring that transitions in reads as transparent on the first frame
    await page.waitForTimeout(250)
    const r = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const ink = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      const parse = (c) => {
        ink.clearRect(0, 0, 1, 1)
        ink.fillStyle = '#000'
        ink.fillStyle = c
        ink.fillRect(0, 0, 1, 1)
        const d = ink.getImageData(0, 0, 1, 1).data
        return [d[0], d[1], d[2], d[3] / 255]
      }
      const lum = ([r, g, b]) => {
        const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
      // the background just outside the control
      let bg = parse(getComputedStyle(document.body).backgroundColor)
      for (let e = el.parentElement; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor)
        if (c[3] > 0.9) { bg = c; break }
      }
      const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30)
      // the indicator may be the element's own outline or ring, a pseudo
      // element's, or its wrapper's (a search field rings its label)
      const boxes = [[el, null], [el, '::after'], [el, '::before'], [el.parentElement, null], [el.parentElement?.parentElement, null]]
      let best = null
      for (const [e, pseudo] of boxes) {
        if (!e) continue
        const cs = getComputedStyle(e, pseudo)
        const ow = parseFloat(cs.outlineWidth)
        if (cs.outlineStyle !== 'none' && ow >= 1) {
          const v = ratio(parse(cs.outlineColor), bg)
          if (!best || v > best.ratio) best = { name, kind: 'outline' + (pseudo || ''), ratio: +v.toFixed(2) }
        }
        if (cs.boxShadow !== 'none') {
          // each ring's colour; the strongest one is the indicator (an inner
          // ring in the page colour is a gap, not the indicator)
          for (const c of cs.boxShadow.match(/(rgba?|oklch|oklab|color|hsla?)\([^)]*\)/g) || []) {
            const pc = parse(c)
            if (pc[3] < 0.5) continue
            const v = ratio(pc, bg)
            if (!best || v > best.ratio) best = { name, kind: 'ring' + (pseudo || ''), ratio: +v.toFixed(2) }
          }
        }
        // a bare input in a field-drawing label: the label's border turns
        if (e !== el && el.tagName === 'INPUT' && parseFloat(cs.borderLeftWidth) >= 1 && cs.borderLeftStyle !== 'none') {
          const v = ratio(parse(cs.borderLeftColor), bg)
          if (!best || v > best.ratio) best = { name, kind: 'border', ratio: +v.toFixed(2) }
        }
        if (e !== el && best) break
      }
      return best || { name, kind: 'none', ratio: 0, tag: el.tagName.toLowerCase() + '.' + el.className.toString().slice(0, 40) }
    })
    if (r && r.ratio < 3) bad.push(r)
  }
  return bad
}

const browser = await launch(chromium)
const report = []
for (const theme of THEMES)
  for (const vpName of VIEWPORTS) {
    const ctx = await browser.newContext({ ...VP[vpName], colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' })
    const page = await ctx.newPage()
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
    // the login screen itself, before signing in
    const routes = ['(login)', ...ROUTES]
    for (const route of routes) {
      if (route !== '(login)') await page.goto(BASE + route, { waitUntil: 'load' })
      await page.waitForTimeout(1200)
      // a stored choice would win over the emulated scheme
      await page.evaluate((t) => { localStorage.setItem('weebsync.theme', t); document.documentElement.dataset.theme = t }, theme)
      // --inject '<css>': a known failure, to prove a clean run is not a blind one
      if (arg('inject', '')) await page.addStyleTag({ content: arg('inject', '') })
      await page.waitForTimeout(200)
      // every screenful: the measure only trusts what is painted in view
      const seen = { text: new Map(), exempt: new Map(), nontext: new Map() }
      for (let step = 0; step < 15; step++) {
        const m = await page.evaluate(measure)
        const img = await imageCases(page, m.images)
        for (const t of [...m.text, ...img]) seen.text.set(t.el + t.text, t)
        for (const t of m.exempt) seen.exempt.set(t.el + t.text, t)
        for (const t of m.nontext) seen.nontext.set(t.what + t.el, t)
        const moved = await page.evaluate(() => {
          let best = document.scrollingElement
          for (const el of document.querySelectorAll('main, dialog[open] *')) {
            if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight - el.clientHeight > best.scrollHeight - best.clientHeight) best = el
          }
          const before = best.scrollTop
          best.scrollTop = before + best.clientHeight * 0.8
          return best.scrollTop !== before
        })
        if (!moved) break
        await page.waitForTimeout(150)
      }
      await page.evaluate(() => { for (const el of [document.scrollingElement, document.querySelector('main')]) if (el) el.scrollTop = 0 })
      const focus = await focusRing(page)
      report.push({ theme, viewport: vpName, route, text: [...seen.text.values()], exempt: [...seen.exempt.values()], nontext: [...seen.nontext.values()], focus })
      if (route === '(login)') await signIn(ctx, page, BASE)
    }
    await ctx.close()
  }
await browser.close()
writeFileSync(arg('out', './contrast-report.json'), JSON.stringify(report, null, 2))

let bad = 0
for (const r of report) {
  const n = r.text.length + r.nontext.length + r.focus.length
  if (!n) continue
  bad++
  console.log(`✗ ${r.theme}/${r.viewport} ${r.route}: ${r.text.length}x text, ${r.nontext.length}x non-text, ${r.focus.length}x focus`)
  for (const t of r.text.slice(0, 6)) console.log(`    Text ${t.ratio}:1 < ${t.need} "${t.text}" (${t.el})${t.overImage ? ' [image]' : ''}${t.bg ? ' on ' + t.bg : ''}`)
  for (const t of r.nontext.slice(0, 6)) console.log(`    ${t.what} ${t.ratio}:1 ${t.el} ${t.type || t.label || ''}`)
  for (const t of r.focus.slice(0, 4)) console.log(`    focus ${t.kind} ${t.ratio}:1 "${t.name}"`)
}
console.log(bad ? `\n${bad}/${report.length} runs with findings` : `\n✓ ${report.length} runs: no contrast findings`)
if (bad) process.exitCode = 1
