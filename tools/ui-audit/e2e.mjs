// End-to-end pass over the running app: every route, in Chromium and Firefox,
// at desktop, both tablet orientations, Pixel 8 Pro and iPhone 14. Checks what a
// screenshot cannot - WCAG 2.2 AA text contrast (1.4.3) and target size (2.5.8),
// console errors, control heights per family, labels that wrapped, whether the
// mobile shell stays pinned, how close content sits to a scroller's scrollbar,
// scrollers a keyboard cannot reach (2.1.1) and focus hidden behind sticky
// chrome (2.4.11) - and leaves one screenshot per route/browser/viewport behind.
//
//   WS_EMAIL=... WS_PASSWORD=... node tools/ui-audit/e2e.mjs [--base http://127.0.0.1:8099] [--out ./e2e-shots] [--tag before]
import { chromium, firefox } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { scanLayout } from './overlap.mjs'
import { launch, signIn } from './auth.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : dflt
}
const BASE = arg('base', 'http://127.0.0.1:8099')
// WS_LANG=en audits the English UI; German is the default
const LANG = process.env.WS_LANG === 'en' ? 'en' : 'de'
const OUT = arg('out', './e2e-shots')
const TAG = arg('tag', '')
const INJECT = arg('inject', '')

const ROUTES = arg('routes', '').split(',').filter(Boolean).length
  ? arg('routes', '').split(',')
  : [
  '/', '/files', '/files?source=local', '/files/trash', '/history', '/watches', '/watches?view=calendar', '/watches?layout=grid',
  '/discover/merkliste', '/discover/empfohlen', '/discover/trending', '/discover/upgrades', '/discover/unvollstaendig',
  '/discover/duplikate', '/discover/ausgeblendet', '/discover/assistent', '/rename', '/rules', '/needs', '/calendar', '/play', '/view',
  '/settings', '/settings/general', '/settings/about', '/settings/account', '/settings/sync', '/settings/notifications', '/settings/servers',
  '/settings/downloads', '/settings/playback', '/settings/security', '/settings/integrations',
  '/settings/jobs', '/settings/matching', '/settings/data',
]
// States a route only shows after a click: extra fields that fold in. Each is
// audited as a route of its own, after the click.
const STATES = [
  { route: '/settings/sync', label: 'subfolder series title', click: /^Serientitel$|^Series title$/ },
  { route: '/settings/sync', label: 'subfolder remote folder', click: /^Remote-Ordner$|^Remote folder$/ },
  // the series page: an overlay on the list (own scroller, own top bar), reached
  // through the first watch's tile
  { route: '/watches', label: 'series page', open: async (page) => {
    const tile = page.locator('.w-tile').first()
    if (!(await tile.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) return false
    await tile.click()
    return page.locator('.ws-detail').waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)
  } },
]

const ALL_VIEWPORTS = {
  // the two sizes the layout pass was written against: a 448px phone and a
  // wide desktop window
  phone: { viewport: { width: 448, height: 998 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  wide: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  // Pixel 8 Pro: the CSS viewport Firefox for Android gives it
  pixel: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  // iPad Air: below and above the 64rem breakpoint, where <main> scrolls on the
  // portrait one and the document on the landscape one
  tabletP: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tabletL: { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  // iPhone 14 - the narrower of the two target phones, and therefore the one
  // that finds the labels which no longer fit on a single line
  iphone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  // WCAG 1.4.10 reflow: 320 CSS px. Opt-in, it is the slowest of the sweep
  narrow: { viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
}
// --viewports phone,wide,narrow picks a subset; the default covers desktop,
// both tablets, the Pixel and the iPhone (add `narrow` for 320px and `wide`
// for 1440px)
const VIEWPORTS = Object.fromEntries(
  arg('viewports', 'desktop,tabletP,tabletL,pixel,iphone').split(',').map((k) => [k, ALL_VIEWPORTS[k]]),
)
const BROWSERS = arg('browsers', 'chromium,firefox').split(',')

// Runs in the page. Walks every text node for contrast and every interactive
// element for target size, and collects one height per control family.
const audit = () => {
  // Computed colours come back as oklab() / color(srgb ...) / color-mix()
  // results as often as rgb(), and splitting digits out of those reads garbage
  // (an oklab background came out as near-black). A 1x1 canvas converts any
  // CSS colour the browser understands to 8-bit sRGB.
  const px = document.createElement('canvas')
  px.width = px.height = 1
  const g2d = px.getContext('2d', { willReadFrequently: true })
  const memo = new Map()
  const rgba = (c) => {
    if (!memo.has(c)) {
      g2d.clearRect(0, 0, 1, 1)
      g2d.fillStyle = '#000'
      g2d.fillStyle = c
      g2d.fillRect(0, 0, 1, 1)
      const d = g2d.getImageData(0, 0, 1, 1).data
      const a = d[3] / 255
      memo.set(c, a === 0 ? [0, 0, 0, 0] : [d[0], d[1], d[2], a])
    }
    return memo.get(c)
  }
  const lum = ([r, g, b]) => {
    const [x, y, z] = [r, g, b].map((v) => {
      v /= 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * x + 0.7152 * y + 0.0722 * z
  }
  // The colour actually behind an element: translucent backgrounds are blended
  // over their ancestors until one is opaque (glass headers are translucent, and
  // taking the first non-transparent ancestor as opaque read a page title as
  // 1.3:1). An image or a backdrop blur anywhere in that stack cannot be
  // computed from styles: null, left to contrast.mjs, which samples pixels.
  const bgOf = (el) => {
    const layers = []
    let opaque = false
    for (let n = el; n && !opaque; n = n.parentElement) {
      const cs = getComputedStyle(n)
      const bd = cs.backdropFilter || cs.webkitBackdropFilter
      if (cs.backgroundImage !== 'none' || (bd && bd !== 'none')) return null
      const b = rgba(cs.backgroundColor)
      if (b[3] > 0) layers.push(b)
      opaque = b[3] >= 1
    }
    // the canvas is white when nothing paints it
    let out = opaque ? layers.pop() : [255, 255, 255, 1]
    while (layers.length) {
      const [r, g, b, a] = layers.pop()
      out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a), 1]
    }
    return out
  }
  const ratio = (fgCss, bg) => {
    const f = rgba(fgCss)
    if (f[3] === 0) return 21 // invisible, not low contrast
    // text with an alpha is blended over what is behind it first
    const fg = [0, 1, 2].map((i) => f[i] * f[3] + bg[i] * (1 - f[3]))
    const l1 = lum(fg), l2 = lum(bg)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  const visible = (el) => {
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  const contrast = []
  let deferred = 0
  for (const el of document.querySelectorAll('body *')) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('')
    if (!own || !visible(el)) continue
    const cs = getComputedStyle(el)
    const size = parseFloat(cs.fontSize)
    const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700)
    const bg = bgOf(el)
    if (!bg) {
      deferred++
      continue
    }
    const r = ratio(cs.color, bg)
    if (r < (large ? 3 : 4.5)) contrast.push({ text: own.slice(0, 40), size: +size.toFixed(1), ratio: +r.toFixed(2) })
  }

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
  for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="option"], [role="tab"], [tabindex]:not([tabindex="-1"])')) {
    if (!visible(el) || el.disabled) continue
    const cs = getComputedStyle(el)
    // visually hidden control behind a visible label (file inputs): the label
    // carries the target, this element is not the hit area
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') continue
    // 2.5.8 exempts a link inline in a sentence
    if (el.tagName === 'A' && cs.display.startsWith('inline')) continue
    const b = hitBox(el)
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
    // ...and the same failure one step smaller: a nowrap element whose own text
    // runs past its border. scrollWidth does not report it - an overflowing
    // TEXT node adds nothing there - so the width it needs comes from a
    // detached clone, the same trick the wrap check below uses. This is how a
    // sidebar entry came to sit flush against its own edge.
    else if (
      cs.whiteSpace === 'nowrap' &&
      cs.overflowX === 'visible' &&
      el.tagName !== 'OPTION' && // never laid out; a clone of one measures nothing real
      cs.position !== 'absolute' && // a decorative overlay is sized by its own box, not by its text
      el.getBoundingClientRect().width > 0 &&
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    ) {
      const clone = el.cloneNode(true)
      clone.style.cssText += ';position:absolute;left:-9999px;top:0;width:auto;max-width:none;white-space:nowrap'
      // next to the original, not on <body>: the font size, weight and letter
      // spacing a nav link inherits are not the body's, and a clone out there
      // "needed" 10px more than the real thing ever did
      el.parentElement.appendChild(clone)
      const needs = clone.getBoundingClientRect().width
      clone.remove()
      const has = el.getBoundingClientRect().width
      if (needs > has + 4)
        scroll.push({ where: el.className?.toString().slice(0, 40) || el.tagName, axis: 'x', overflow: Math.round(needs - has), text: (el.textContent || '').trim().slice(0, 30), hangs: true })
    }
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
  // Which box actually scrolls: on a phone the document does not - the shell is
  // a fixed-height, clipped column and <main> is the scroller (that is what
  // keeps the browser's dynamic toolbar out of the layout). Every check below
  // has to ask that box, or it measures a document that can never move and
  // passes for the wrong reason.
  const scroller = (() => {
    const m = document.querySelector('.app-shell > main')
    return m && ['auto', 'scroll'].includes(getComputedStyle(m).overflowY) ? m : null
  })()
  const getTop = () => (scroller ? scroller.scrollTop : scrollY)
  const setTop = (v) => (scroller ? (scroller.scrollTop = v) : scrollTo(0, v))
  const scrollH = () => (scroller ? scroller.scrollHeight : doc.scrollHeight)
  const clientH = () => (scroller ? scroller.clientHeight : innerHeight)
  // The shell's own two bars, found by where they sit in the tree rather than
  // by how they are positioned: they used to be `fixed` and `sticky`, and a
  // check keyed on that would have gone quietly blind the moment they became
  // ordinary rows of the shell - which is exactly the change that fixed them.
  // `visible` matters: on desktop both are display:none but keep their
  // position, and a zero-size rect would read as "pinned 900px too high"
  const nav = [...document.querySelectorAll('.app-shell > nav')].find(visible)
  const header = [...document.querySelectorAll('.app-shell > header')].find(visible)
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
  const y0 = getTop()
  setTop(400)
  check('after scrolling')
  setTop(y0)
  // The shell clips sideways on a phone, so content too wide for the screen no
  // longer announces itself as a document scrollbar - it is simply cut off.
  // Ask the boxes that do the clipping what they are hiding.
  for (const box of [document.querySelector('.app-shell'), scroller]) {
    if (!box) continue
    const cs = getComputedStyle(box)
    if (!['hidden', 'clip'].includes(cs.overflowX)) continue
    const right = box.getBoundingClientRect().right
    let out = 0, who2 = null
    for (const el of box.querySelectorAll('*')) {
      if (!visible(el)) continue
      const ecs = getComputedStyle(el)
      if (ecs.position === 'fixed') continue
      // a box that scrolls sideways on purpose keeps its content reachable, and
      // a box that clips on its own (a `truncate` title cutting its year off
      // with an ellipsis) has already dealt with the overflow - in neither case
      // is the shell the one hiding something
      let handled = false
      for (let p = el.parentElement; p && p !== box; p = p.parentElement)
        if (getComputedStyle(p).overflowX !== 'visible') { handled = true; break }
      if (handled) continue
      const over = Math.round(el.getBoundingClientRect().right - right)
      if (over > out) { out = over; who2 = el.tagName.toLowerCase() + '.' + el.className.toString().slice(0, 40) }
    }
    if (out > 1) shell.push({ what: `content cut off at the right edge (${who2})`, off: out })
  }

  // Where <main> is the scroller, the document must not scroll at all - one
  // gesture cannot drive two scrollers, and whatever moves the document takes
  // the header and the tab bar with it. A single absolutely positioned box
  // whose nearest positioned ancestor is the document is enough to cause it:
  // the shell cannot clip what it does not contain, and the box's static
  // position, measured deep inside the scrolling content, stretches the page
  // to reach it. Name the culprit rather than just the symptom.
  if (scroller && doc.scrollHeight > doc.clientHeight + 1) {
    let who3 = null
    let low = doc.clientHeight
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue
      const b = el.getBoundingClientRect().bottom + scrollY
      if (b > low) { low = b; who3 = el.tagName.toLowerCase() + '.' + el.className.toString().slice(0, 40) }
    }
    shell.push({
      what: `the document scrolls behind the shell${who3 ? ` (${who3} escapes it)` : ''}`,
      off: doc.scrollHeight - doc.clientHeight,
    })
  }

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
  // the shell's own scroller is the frame of reference here, not "a scroll
  // container of its own" - stopping the walk there is what keeps the check
  // from excusing the whole page as reachable
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== doc && p !== scroller; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (['auto', 'scroll'].includes(cs.overflowY) || ['auto', 'scroll'].includes(cs.overflowX)) return true
    }
    return false
  }
  const originTop = scroller ? scroller.getBoundingClientRect().top : 0
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.position === 'fixed') continue
    if (scroller && !scroller.contains(el)) continue
    // not shown at all (a closed <details>) or collapsed and inert (the account
    // menu's fold) is not content the user has lost
    if (!el.checkVisibility({ contentVisibilityAuto: true }) || el.closest('[inert]') || inScroller(el)) continue
    // (contentVisibilityAuto also drops rows a content-visibility:auto list has
    // not rendered: their boxes are estimates, 92px off the real ones)
    // checkVisibility() does not look through a closed <details> (its content
    // is hidden by the shadow slot, not by an ancestor): a long list in a
    // collapsed group measured 60000px deep
    const det = el.closest('details:not([open])')
    if (det && !el.closest('summary')) continue
    const r = el.getBoundingClientRect()
    if (!r.height) continue
    const b = r.bottom - originTop + getTop()
    if (b > deepest) {
      deepest = b
      who = el.tagName.toLowerCase() + '.' + el.className.toString().slice(0, 40)
    }
  }
  const unreachable = Math.round(deepest - scrollH())
  if (unreachable > 1) shell.push({ what: `content below the scrollable area (${who})`, off: unreachable })
  // The mirror image: a scroll range nothing occupies. What the range is made
  // of is the deepest box plus the end padding the scroller reserves, so a page
  // twelve pixels taller than the screen does not count - that is a page. The
  // old "small overflow means phantom" rule called it one, and firefox's font
  // metrics were enough to put a settings page under the threshold.
  const padEnd = parseFloat(getComputedStyle(scroller || doc).paddingBottom) || 0
  const phantom = Math.round(scrollH() - Math.max(deepest + padEnd, clientH()))
  if (phantom > 1) shell.push({ what: 'phantom overflow - the page scrolls without content to scroll', off: phantom })
  if (scrollH() > clientH() + 1) {
    setTop(scrollH())
    const reached = getTop()
    setTop(y0)
    const short = Math.round(scrollH() - clientH() - reached)
    if (short > 2) shell.push({ what: 'the page stops scrolling before its end', off: short })
  }
  const locked = (el) => getComputedStyle(el).overflowY === 'hidden'
  if ((locked(doc) || (scroller && locked(scroller))) && !document.querySelector('dialog[open]'))
    shell.push({ what: 'the page is locked against scrolling with no modal open', off: 0 })

  return { contrast, deferred, targets, heights, offenders, scroll, wrapped, shell, title: document.title }
}

// Runs in the page. Every scroll container that actually overflows: how wide
// its scrollbar is, how close the interactive content sits to it, and whether a
// keyboard can reach it. A control flush with the content edge is hidden under a
// classic scrollbar (15px on desktop) or too close to an overlay one to hit.
const scrollers = () => {
  const doc = document.documentElement
  const visible = (e) => {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e)
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  const name = (e) => {
    if (!(e instanceof Element)) return '?'
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + [...e.classList].slice(0, 3).map((c) => '.' + c).join('')
  }
  const path = (e) => {
    const p = []
    for (let i = 0; e && i < 4; i++, e = e.parentElement) p.push(name(e))
    return p.reverse().join(' > ')
  }
  const all = [...document.body.querySelectorAll('*')]
  const INTER = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])'
  const out = { scrollers: [], hscroll: null, notFocusable: [] }

  // the page or <main> scrolling sideways, with the boxes that stick out
  const main = document.querySelector('main')
  if (doc.scrollWidth > doc.clientWidth + 1 || (main && main.scrollWidth > main.clientWidth + 1)) {
    const vw = doc.clientWidth
    const clipped = (e) => {
      for (let p = e.parentElement; p && p !== document.body && p !== doc; p = p.parentElement) {
        const cs = getComputedStyle(p)
        if (cs.position === 'fixed') return false
        if (cs.overflowX !== 'visible' || cs.contain.includes('paint')) return true
      }
      return false
    }
    const culprits = []
    for (const e of all) {
      if (culprits.length >= 8) break
      if (!visible(e) || getComputedStyle(e).position === 'fixed' || clipped(e)) continue
      const r = e.getBoundingClientRect()
      if (r.right > vw + 1 || r.left < -1) culprits.push(`${path(e)} [${Math.round(r.left)}..${Math.round(r.right)}]`)
    }
    out.hscroll = {
      html: doc.scrollWidth - doc.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
      culprits,
    }
  }

  for (const e of all) {
    const cs = getComputedStyle(e)
    const ox = /auto|scroll/.test(cs.overflowX), oy = /auto|scroll/.test(cs.overflowY)
    if (!(ox || oy) || !visible(e)) continue
    const overY = oy && e.scrollHeight > e.clientHeight + 1
    const overX = ox && e.scrollWidth > e.clientWidth + 1
    if (!overY && !overX) continue
    const r = e.getBoundingClientRect()
    const sbw = e.offsetWidth - e.clientWidth - (parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth))
    const edge = r.left + e.clientLeft + e.clientWidth
    const kids = [...e.querySelectorAll(INTER)].filter(visible)
    // smallest distance between an interactive descendant and the content edge,
    // among those in view (a row scrolled away says nothing about its gap)
    let gap = null, who = null
    if (overY)
      for (const k of kids) {
        const kr = k.getBoundingClientRect()
        if (kr.bottom < r.top || kr.top > r.bottom || kr.left > edge) continue
        // inside a scroller of its own (a tab strip), the clipping is that box's
        let nested = false
        for (let p = k.parentElement; p && p !== e; p = p.parentElement)
          if (/auto|scroll/.test(getComputedStyle(p).overflowX)) nested = true
        if (nested) continue
        const g = edge - kr.right
        if (g > -400 && (gap === null || g < gap)) {
          gap = g
          who = path(k)
        }
      }
    const row = {
      el: path(e), overX, overY, sbw: Math.round(sbw * 10) / 10,
      padL: cs.paddingLeft, padR: cs.paddingRight,
      gap: gap === null ? null : Math.round(gap * 10) / 10, gapEl: who,
    }
    // a classic scrollbar needs room beside the content, an overlay one still
    // has a thumb sitting over the last few pixels
    const need = row.sbw > 0 ? 8 : 4
    row.tight = overY && row.gap !== null && row.gap < need ? need : 0
    out.scrollers.push(row)
    // 2.1.1: a scroller with nothing focusable in it cannot be scrolled by keyboard
    // (Firefox makes it a tab stop by itself, Chromium does not)
    if (e.tabIndex < 0 && !kids.some((k) => k.tabIndex >= 0 && !k.disabled))
      out.notFocusable.push({ el: path(e), axis: overY ? 'y' : 'x' })
  }
  return out
}

// Runs in the page after each Tab: how much of the focused element something
// else covers (2.4.11 Focus Not Obscured), sampled at the centre and four
// corners. A sticky header or tab bar over the focus ring is the usual cause.
const focusInfo = () => {
  const a = document.activeElement
  if (!a || a === document.body) return null
  const r = a.getBoundingClientRect()
  const vw = document.documentElement.clientWidth, vh = innerHeight
  if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return null
  const lab = a.closest('label')
  let covered = 0, by = null
  for (const [fx, fy] of [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) {
    const x = r.left + r.width * fx, y = r.top + r.height * fy
    if (x < 0 || y < 0 || x >= vw || y >= vh) continue
    const t = document.elementFromPoint(x, y)
    if (!t || a.contains(t) || t.contains(a) || (lab && t.closest('label') === lab)) continue
    covered++
    by = t.tagName.toLowerCase() + [...t.classList].slice(0, 3).map((c) => '.' + c).join('')
  }
  return {
    el: a.tagName.toLowerCase() + [...a.classList].slice(0, 3).map((c) => '.' + c).join(''),
    text: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30),
    covered, by,
  }
}

// Firefox lands the focus scroll after the key press returns: wait until the
// focused element's rect holds still across two samples, or give up after 1.5s
const settleFocus = (page) =>
  page.evaluate(async () => {
    const rect = () => {
      const r = document.activeElement?.getBoundingClientRect()
      return r ? `${r.top}|${r.left}|${r.width}|${r.height}` : ''
    }
    const end = performance.now() + 1500
    let prev = rect()
    while (performance.now() < end) {
      await new Promise((r) => setTimeout(r, 80))
      const cur = rect()
      if (cur === prev) return
      prev = cur
    }
  }).catch(() => {})

// Tab through the first stops of the page and report what a sticky bar hides:
// all five sample points covered fails, two or more is a warning
const focusWalk = async (page, n = 40) => {
  const res = []
  const seen = new Set()
  await page.evaluate(() => {
    document.activeElement?.blur?.()
    scrollTo(0, 0)
  })
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab')
    await settleFocus(page)
    const f = await page.evaluate(focusInfo).catch(() => null)
    if (!f) continue
    const k = `${f.el}|${f.text}`
    if (seen.has(k)) continue
    seen.add(k)
    if (f.covered >= 2) res.push({ ...f, fail: f.covered === 5 })
  }
  return res
}

const run = async (name, browserType) => {
  const browser = await launch(browserType)
  const findings = []
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    // the app follows the OS scheme unless a choice is stored: WS_THEME=dark runs the dark look
    // no service worker: a rebuild of the instance under test would reload the
    // page mid-run, and a cached stylesheet would audit the old look. Reduced
    // motion: entry animations hold text at opacity 0 for a moment, and text
    // mid-wipe is neither readable nor fairly measured.
    const ctx = await browser.newContext({
      ...vp,
      colorScheme: process.env.WS_THEME === 'dark' ? 'dark' : 'light',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
      locale: LANG === 'en' ? 'en-US' : 'de-DE',
    })
    // the app keeps the language it was last shown in: set it before it reads it
    await ctx.addInitScript((l) => localStorage.setItem('weebsync.locale', l), LANG)
    // --inject '<css>' adds a known failure, to check that a clean run is not a blind one
    if (INJECT)
      await ctx.addInitScript((css) => addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: css }))), INJECT)
    const page = await ctx.newPage()
    const errors = []
    // a navigation aborts the app's open SSE streams; that is expected noise
    // 2152398850 = 0x804b0002 = NS_BINDING_ABORTED: Firefox reports a font whose
    // download the next navigation cut short, which is the harness, not the app
    const noise = /was interrupted while the page was loading|NS_BINDING_ABORTED|net::ERR_ABORTED|Failed to load resource.*events|downloadable font.*2152398850/i
    page.on('console', (m) => m.type() === 'error' && !noise.test(m.text()) && errors.push(m.text().slice(0, 160)))
    page.on('pageerror', (e) => !noise.test(e.message) && errors.push('pageerror: ' + e.message.slice(0, 160)))

    await signIn(ctx, page, BASE)
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })

    // The catalogue's poster grid only fills where a folder matched a title,
    // and a server's root rarely has one - so the densest layout in the app,
    // the one whose buttons hung over the card edge, would never be in this
    // sweep. Ask the API
    // for a folder that actually matched a title instead of hardcoding a path
    // out of somebody's library.
    const extra = await page.evaluate(async () => {
      const servers = await (await fetch('/api/servers', { credentials: 'include' })).json()
      // local first: every step below is a live listing, and this sweep runs six
      // browser contexts at once - a remote box would see six parallel walks
      const local = servers.filter((s) => /^(localhost|127\.|\[?::1)/.test(s.host))
      const queue = (local.length ? local : servers).map((s) => ({ id: s.id, path: '' }))
      for (let i = 0; i < 8 && queue.length; i++) {
        const { id, path } = queue.shift()
        const r = await fetch(`/api/servers/${id}/catalog${path ? `?path=${encodeURIComponent(path)}` : ''}`, { credentials: 'include' })
        if (!r.ok) continue
        const items = (await r.json()).items || []
        if (items.some((it) => it.media)) return `/files?server=${id}&path=${encodeURIComponent(path.replace(/^\//, ''))}`
        for (const it of items) queue.push({ id, path: it.entry.path })
      }
      return null
    }).catch(() => null)

    const passes = [
      ...[...ROUTES, ...(extra ? [extra] : [])].map((route) => ({ route })),
      ...STATES.filter((st) => !arg('routes', '') || ROUTES.includes(st.route)),
    ]
    for (const { route, label, click, open } of passes) {
      errors.length = 0
      // not networkidle: the app keeps an SSE stream open, so it never idles
      await page.goto(BASE + route, { waitUntil: 'load' })
      await page.waitForTimeout(600)
      if (open && !(await open(page))) {
        findings.push({ browser: name, viewport: vpName, route: `${route} (${label})`, missing: true })
        continue
      }
      if (open) await page.waitForTimeout(800)
      if (click) {
        const ctl = page.getByRole('radio', { name: click }).or(page.getByRole('button', { name: click })).first()
        if (!(await ctl.count().catch(() => 0))) {
          findings.push({ browser: name, viewport: vpName, route: `${route} (${label})`, missing: true })
          continue
        }
        await ctl.click()
        await page.waitForTimeout(500)
      }
      const r = await page.evaluate(audit)
      Object.assign(r, await page.evaluate(scrollers))
      const slug = (route + (label ? '-' + label : '')).replace(/[^\w-]+/g, '_') || '_root'
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
      const layout = await scanLayout(page)
      // last: walking the focus order scrolls the page
      r.focus = await focusWalk(page)
      findings.push({ browser: name, viewport: vpName, route: label ? `${route} (${label})` : route, ...r, layout, errors: [...new Set(errors)], shot: file })
    }
    await ctx.close()
  }
  await browser.close()
  return findings
}

mkdirSync(OUT, { recursive: true })
const engines = { chromium, firefox }
const all = []
for (const b of BROWSERS) all.push(...(await run(b, engines[b])))
writeFileSync(`${OUT}/${TAG ? TAG + '-' : ''}report.json`, JSON.stringify(all, null, 2))

let bad = 0
for (const f of all) {
  const problems = []
  if (f.missing) {
    bad++
    console.log(`✗ ${f.browser}/${f.viewport} ${f.route}: state not reachable`)
    continue
  }
  const lay = f.layout || { overlaps: [], escapes: [], clipped: [] }
  if (lay.overlaps.length) problems.push(`${lay.overlaps.length}x text over text`)
  if (lay.escapes.length) problems.push(`${lay.escapes.length}x text escapes its box`)
  if (lay.clipped.length) problems.push(`${lay.clipped.length}x text clipped`)
  if (f.contrast.length) problems.push(`${f.contrast.length}x contrast (min ${Math.min(...f.contrast.map((c) => c.ratio))}:1)`)
  if (f.targets.length) problems.push(`${f.targets.length}x target size`)
  if (f.errors.length) problems.push(`${f.errors.length}x console error`)
  if (f.scroll?.length) problems.push(`${f.scroll.length}x scrollbar`)
  const tight = (f.scrollers || []).filter((x) => x.tight)
  const hard = (f.focus || []).filter((x) => x.fail)
  if (f.hscroll) problems.push(`sideways overflow (html +${f.hscroll.html}, main +${f.hscroll.main})`)
  if (tight.length) problems.push(`${tight.length}x scroller content too close to the scrollbar`)
  if (f.notFocusable?.length) problems.push(`${f.notFocusable.length}x scroller not keyboard reachable (2.1.1)`)
  if (hard.length) problems.push(`${hard.length}x focus obscured (2.4.11)`)
  if (f.wrapped?.length) problems.push(`${f.wrapped.length}x label wrapped`)
  if (f.shell?.length) problems.push(`${f.shell.length}x shell shifted`)
  for (const [fam, rows] of Object.entries(f.offenders || {})) problems.push(`${fam}: ${rows.length}x mixed heights in a row`)
  // two to four of five points covered: worth a look, not a failure
  for (const x of (f.focus || []).filter((x) => !x.fail))
    console.log(`  ⚠ ${f.browser}/${f.viewport} ${f.route}: focus <${x.el}> "${x.text}" covered ${x.covered}/5 by ${x.by}`)
  if (problems.length) {
    bad++
    console.log(`✗ ${f.browser}/${f.viewport} ${f.route}: ${problems.join(' · ')}`)
    for (const o of lay.overlaps.slice(0, 6)) console.log(`    overlap ${o.w}x${o.h}px "${o.a}" (${o.ae}) / "${o.b}" (${o.be})`)
    for (const o of lay.escapes.slice(0, 6)) console.log(`    escapes ${o.box} by ${o.dx}/${o.dy}px: "${o.text}"`)
    for (const o of lay.clipped.slice(0, 6)) console.log(`    clipped by ${o.by}: "${o.text}" (${o.el})`)
    for (const c of f.contrast.slice(0, 4)) console.log(`    contrast ${c.ratio}:1 ${c.size}px "${c.text}"`)
    if (f.hscroll) for (const c of f.hscroll.culprits) console.log(`    overflow culprit ${c}`)
    for (const x of tight) console.log(`    scroller ${x.el}: gap ${x.gap}px < ${x.tight}px (scrollbar ${x.sbw}px, padding ${x.padL}/${x.padR}) at ${x.gapEl}`)
    for (const x of f.notFocusable || []) console.log(`    scroller ${x.el} (${x.axis}) has no focusable content and no tabindex`)
    for (const x of hard) console.log(`    focus <${x.el}> "${x.text}" covered 5/5 by ${x.by}`)
    for (const t of f.targets.slice(0, 4)) console.log(`    target ${t.w}x${t.h} <${t.tag}> "${t.text}"`)
    for (const sc of (f.scroll || []).slice(0, 4)) console.log(`    Scroll ${sc.axis} +${sc.overflow}px in "${sc.where}"`)
    for (const w of (f.wrapped || []).slice(0, 6)) console.log(`    wrap ${w.lines} lines: ${w.w}px available, ${w.needs}px needed "${w.text}"`)
    for (const s of (f.shell || []).slice(0, 4)) console.log(`    Shell ${s.what}${s.when ? ` (${s.when})` : ''}: ${s.off}px`)
    for (const [fam, rows] of Object.entries(f.offenders || {}))
      for (const r of rows) console.log(`    ${fam} ${r.h}px x${r.n}  ${r.sample}`)
    for (const e of f.errors.slice(0, 3)) console.log(`    ${e}`)
  }
}
console.log(`${all.reduce((n, f) => n + (f.deferred || 0), 0)} text nodes over an image or backdrop blur: deferred to contrast.mjs`)
console.log(bad === 0
  ? `\n✓ ${all.length} page runs (${BROWSERS.length} browsers x ${Object.keys(VIEWPORTS).length} viewports x ${new Set(all.map((r) => r.route)).size} routes): no findings`
  : `\n${bad}/${all.length} page runs with findings`)
