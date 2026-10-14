// Text that lands on other text. Runs in the page and looks at what is on
// screen right now; `scanLayout` scrolls the page's scroller through and
// collects every screenful, because elementsFromPoint (which tells a real
// collision from a card drawn over the page) only sees the viewport.
//
// Three findings, all about text the user cannot read:
// - overlaps: two text runs (or a text run and a form control) whose boxes
//   intersect, neither inside the other, with nothing opaque between them.
//   The case that started it: a field with height:100% in a stretched grid
//   item, whose hint paragraphs ran over the next field's label.
// - escapes: a text run that hangs out of a box with visible overflow - the
//   same bug seen from the box that is too short for its content.
// - clipped: a text run cut by an overflow:hidden box with no ellipsis or
//   line clamp to say there is more.
export const textLayout = (rootSel) => {
  const root = (rootSel && [...document.querySelectorAll(rootSel)].pop()) || document.body
  const tol = 2
  const hidden = (el) => !!el.closest('[aria-hidden="true"], [inert]')
  const desc = (el) => {
    const parts = []
    for (let e = el, i = 0; e && e !== document.body && i < 3; e = e.parentElement, i++) {
      const cls = [...e.classList].slice(0, 2)
      parts.unshift(e.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : ''))
    }
    return parts.join('>')
  }
  const opaque = (cs) => {
    if (cs.backgroundImage !== 'none' || cs.backdropFilter !== 'none') return true
    const m = cs.backgroundColor.match(/[\d.]+/g)
    if (!m) return false
    return (m.length > 3 ? +m[3] : 1) > 0.4
  }
  const items = []
  const range = document.createRange()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.data.trim()) continue
    const el = n.parentElement
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/.test(el.tagName)) continue
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || hidden(el)) continue
    // the ink only: whitespace at either end hangs past the line in pre-wrap
    const lead = n.data.length - n.data.trimStart().length
    range.setStart(n, lead)
    range.setEnd(n, lead + n.data.trim().length)
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1)
    if (rects.length) items.push({ el, rects, text: n.data.trim().slice(0, 40) })
  }
  for (const el of root.querySelectorAll('input:not([type=hidden],[type=checkbox],[type=radio],[type=range],[type=color]), select, textarea')) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || hidden(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 2 && r.height > 2) items.push({ el, rects: [r], text: `[${el.tagName.toLowerCase()} ${(el.name || el.placeholder || '').slice(0, 30)}]`, control: true })
  }

  // Each run is cut down to what its overflow ancestors let through. A cut by
  // a scroller is scrolling; a cut by a clipping box without an ellipsis is a
  // finding.
  const clipped = []
  const chains = new Map()
  const chain = (el) => {
    if (chains.has(el)) return chains.get(el)
    const out = []
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') out.push({ e, cs, b: e.getBoundingClientRect() })
      if (cs.position === 'fixed') break
    }
    chains.set(el, out)
    return out
  }
  const signalled = (e) => {
    const s = getComputedStyle(e)
    return s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none')
  }
  for (const it of items) {
    const vis = []
    let cutBy = null
    for (const r of it.rects) {
      let l = r.left, t = r.top, rr = r.right, b = r.bottom
      for (const c of chain(it.el)) {
        if (it.control && c.e === it.el) continue
        const cx = c.cs.overflowX !== 'visible', cy = c.cs.overflowY !== 'visible'
        const nl = cx ? Math.max(l, c.b.left) : l, nr = cx ? Math.min(rr, c.b.right) : rr
        const nt = cy ? Math.max(t, c.b.top) : t, nb = cy ? Math.min(b, c.b.bottom) : b
        const scroller = /auto|scroll/.test(c.cs.overflowX + c.cs.overflowY)
        const lost = rr - l - Math.max(0, nr - nl) > 2 || b - t - Math.max(0, nb - nt) > 2
        if (!cutBy && !scroller && lost && nr - nl > 1 && nb - nt > 1) cutBy = c
        l = nl; rr = nr; t = nt; b = nb
      }
      if (rr - l > 1 && b - t > 1) vis.push({ l, t, r: rr, b })
    }
    if (cutBy && !it.control) {
      let ok = false
      for (let e = it.el; e && e !== cutBy.e.parentElement; e = e.parentElement) if (signalled(e)) { ok = true; break }
      if (!ok) clipped.push({ text: it.text, el: desc(it.el), by: desc(cutBy.e) })
    }
    if (vis.length) {
      it.vis = vis
      it.top = Math.min(...vis.map((v) => v.t))
      it.bottom = Math.max(...vis.map((v) => v.b))
    }
  }

  const live = items.filter((i) => i.vis).sort((a, b) => a.top - b.top)
  const rel = (x, e) => x === e || x.contains(e) || e.contains(x)
  // something opaque between the upper run and the common ancestor that covers
  // the spot: a card, a sheet, a sticky bar over the page - drawn on purpose
  const covered = (top, under, stop, x, y) => {
    for (let e = top; e && e !== stop; e = e.parentElement) {
      if (e.contains(under)) return false
      if (!opaque(getComputedStyle(e))) continue
      const b = e.getBoundingClientRect()
      if (b.left <= x && b.right >= x && b.top <= y && b.bottom >= y) return true
    }
    return false
  }
  const overlaps = []
  for (let i = 0; i < live.length; i++) {
    const A = live[i]
    for (let j = i + 1; j < live.length; j++) {
      const B = live[j]
      if (B.top >= A.bottom - tol) break
      if (A.el === B.el) continue
      if ((A.control && A.el.contains(B.el)) || (B.control && B.el.contains(A.el))) continue
      let hit = null
      for (const va of A.vis) for (const vb of B.vis) {
        const w = Math.min(va.r, vb.r) - Math.max(va.l, vb.l), h = Math.min(va.b, vb.b) - Math.max(va.t, vb.t)
        if (!hit && w > tol && h > tol) hit = { x: (Math.max(va.l, vb.l) + Math.min(va.r, vb.r)) / 2, y: (Math.max(va.t, vb.t) + Math.min(va.b, vb.b)) / 2, w, h }
      }
      if (!hit) continue
      let stop = A.el
      while (stop && !stop.contains(B.el)) stop = stop.parentElement
      const stack = document.elementsFromPoint(hit.x, hit.y)
      const ia = stack.findIndex((e) => rel(A.el, e)), ib = stack.findIndex((e) => rel(B.el, e))
      const up = ia !== -1 && (ib === -1 || ia <= ib) ? A : B
      const down = up === A ? B : A
      const s0 = stack[0]
      if (s0 && !rel(A.el, s0) && !rel(B.el, s0) && !s0.contains(stop) && covered(s0, down.el, stop, hit.x, hit.y)) continue
      if (covered(up.el, down.el, stop, hit.x, hit.y)) continue
      overlaps.push({ a: A.text, ae: desc(A.el), b: B.text, be: desc(B.el), w: Math.round(hit.w), h: Math.round(hit.h) })
    }
  }

  // escapes: the run is outside a box it sits in (positioned boxes are their
  // own layer and end the walk; inline boxes do not bound anything)
  const escapes = []
  const seen = new Set()
  // a content-visibility:auto box that just scrolled into view still has its
  // placeholder size for a frame; it grows to its content, not a finding
  const lazySized = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).contentVisibility === 'auto') return true
    return false
  }
  for (const it of live) {
    if (it.control || lazySized(it.el)) continue
    const l = Math.min(...it.rects.map((r) => r.left)), r = Math.max(...it.rects.map((r) => r.right))
    const t = Math.min(...it.rects.map((r) => r.top)), b = Math.max(...it.rects.map((r) => r.bottom))
    for (let a = it.el, k = 0; a && a !== root.parentElement && k < 8; a = a.parentElement, k++) {
      const cs = getComputedStyle(a)
      if (k > 0 && (cs.position === 'absolute' || cs.position === 'fixed')) break
      if (cs.display === 'inline' || cs.display === 'contents') continue
      if (cs.overflowX !== 'visible' && cs.overflowY !== 'visible') break
      const box = a.getBoundingClientRect()
      if (box.height < 1) continue
      const dy = Math.max(b - box.bottom, box.top - t), dx = Math.max(r - box.right, box.left - l)
      // tight leading (a display heading at 1.08) lets the glyph box hang
      // past its line by design; only what goes beyond that counts
      const lh = parseFloat(getComputedStyle(it.el).lineHeight)
      const hang = lh ? Math.max(0, (it.rects[0].height - lh) / 2) : 0
      if ((dy > 3 + hang && cs.overflowY === 'visible') || (dx > 3 && cs.overflowX === 'visible')) {
        const key = desc(a)
        if (!seen.has(key)) {
          seen.add(key)
          escapes.push({ text: it.text, box: key, dx: Math.round(dx), dy: Math.round(dy) })
        }
        break
      }
    }
  }
  return { overlaps, escapes, clipped }
}

// Scroll the page (or the dialog) through and merge what every screenful found.
export const scanLayout = async (page, rootSel = null) => {
  const merged = { overlaps: new Map(), escapes: new Map(), clipped: new Map() }
  const keys = { overlaps: (o) => `${o.ae}|${o.a}|${o.be}|${o.b}`, escapes: (o) => o.box, clipped: (o) => `${o.el}|${o.text}` }
  for (let step = 0; step < 40; step++) {
    const r = await page.evaluate(textLayout, rootSel)
    for (const k of Object.keys(merged)) for (const o of r[k]) merged[k].set(keys[k](o), o)
    // the biggest visible scroller: <main> on a phone, the document on desktop,
    // the body of a dialog
    const moved = await page.evaluate((sel) => {
      const scope = (sel && [...document.querySelectorAll(sel)].pop()) || document
      let best = sel ? null : document.scrollingElement
      let room = best ? best.scrollHeight - best.clientHeight : 0
      for (const el of scope.querySelectorAll('*')) {
        if (!/auto|scroll/.test(getComputedStyle(el).overflowY)) continue
        const d = el.scrollHeight - el.clientHeight
        if (d > room && el.clientHeight > 200 && el.checkVisibility()) { best = el; room = d }
      }
      if (!best) return false
      const before = best.scrollTop
      best.scrollTop = before + best.clientHeight * 0.7
      return best.scrollTop !== before
    }, rootSel)
    if (!moved) break
    await page.waitForTimeout(150)
  }
  return Object.fromEntries(Object.entries(merged).map(([k, m]) => [k, [...m.values()]]))
}
