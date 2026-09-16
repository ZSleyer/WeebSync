// The phone sheet's gesture contract, driven with REAL touch.
//
// This exists because neither `modals.mjs` nor an ordinary Playwright drag can
// see the failure it guards against. `modals.mjs` measures the sheet standing
// still, and `page.mouse.*` bypasses `touch-action` entirely - so a sheet that
// no thumb could drag passed every check we had, on both engines, while the
// phone sat there doing nothing. CDP's `Input.dispatchTouchEvent` goes through
// Chromium's own input pipeline, which means the browser really does arbitrate
// the gesture and really can swallow it.
//
//   WS_TOKEN=<raw session token> node tools/ui-audit/sheet.mjs [--base http://127.0.0.1:8080]
//
// Chromium only: Playwright's Firefox driver dispatches neither touch events
// nor pointer events for synthetic input, so there is nothing to drive there.
import { chromium } from 'playwright'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:8080')
const TOKEN = process.env.WS_TOKEN || ''

// the two phones the app is actually used on, at their real CSS sizes
const VIEWPORTS = [
  { name: 'pixel8pro', width: 448, height: 998, dpr: 3 },
  { name: 'iphone14', width: 393, height: 852, dpr: 3 },
]

// the sheet's two heights, as fractions of the viewport
const OPENING = 0.7
const FULL = 0.92

const findings = []
const bad = (m) => {
  findings.push(m)
  console.log(`  ✗ ${m}`)
}
const good = (m) => console.log(`  ✓ ${m}`)

const browser = await chromium.launch()
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  })
  if (TOKEN)
    await ctx.addCookies([
      { name: 'weebsync_session', value: TOKEN, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
    ])
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  const tag = vp.name
  console.log(`\n== ${tag} ==`)

  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 12, radiusY: 12, force: 1 }],
    })

  const state = () =>
    page.evaluate(() => {
      const d = [...document.querySelectorAll('dialog[open]')].pop()
      if (!d) return { open: false }
      const s = [...d.querySelectorAll('*')].find(
        (e) => e.scrollHeight > e.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY),
      )
      return {
        open: true,
        transform: d.style.transform,
        h: Math.round(d.getBoundingClientRect().height),
        vh: innerHeight,
        expanded: d.hasAttribute('data-expanded'),
        backdrop: parseFloat(getComputedStyle(d, '::backdrop').opacity),
        scrollTop: s ? s.scrollTop : null,
      }
    })

  // Two snapshots 600ms apart cannot see a one-frame jump, and a one-frame
  // jump is exactly what a snapped detent looks like. So the release is
  // watched frame by frame: `sample` records the sheet's top edge (or the
  // deck's x) on every animation frame and reports the largest step between
  // two consecutive frames - a settle that runs on one curve has small steps,
  // a height that snaps while the transform still holds the pull has one
  // step the size of the jump.
  const sample = (ms, what) =>
    page.evaluate(
      ([ms, what]) =>
        new Promise((done) => {
          const read =
            what === 'deck'
              ? () => {
                  // the innermost swipe zone with a day heading is the deck;
                  // its first child is the track that moves. When a turn
                  // lands the track is relabelled - the index moves on and the
                  // transform drops by one width while the content stays put
                  // - so the reading is taken modulo the width
                  const z = [...document.querySelectorAll('[style*="touch-action"]')].reverse().find((e) => e.querySelector('h3'))
                  const t = z?.firstElementChild ? getComputedStyle(z.firstElementChild).transform : 'none'
                  const x = t && t !== 'none' ? new DOMMatrixReadOnly(t).m41 : 0
                  const w = z?.clientWidth || 1
                  return ((x % w) + w) % w
                }
              : () => {
                  const d = [...document.querySelectorAll('dialog[open]')].pop()
                  return d ? d.getBoundingClientRect().top : NaN
                }
          const ys = []
          const wrap =
            what === 'deck'
              ? [...document.querySelectorAll('[style*="touch-action"]')].reverse().find((e) => e.querySelector('h3'))?.clientWidth
              : 0
          const t0 = performance.now()
          const tick = () => {
            ys.push(read())
            if (performance.now() - t0 < ms) requestAnimationFrame(tick)
            else {
              let max = 0
              for (let i = 1; i < ys.length; i++) {
                let d = Math.abs(ys[i] - ys[i - 1])
                // a deck reading wraps at the width: 5 -> 395 on a 400px deck
                // is a 10px step, not a 390px one
                if (what === 'deck' && wrap) d = Math.min(d, Math.abs(d - wrap))
                if (Number.isFinite(d) && d > max) max = d
              }
              done({ max: Math.round(max), frames: ys.length, from: Math.round(ys[0]), to: Math.round(ys[ys.length - 1]) })
            }
          }
          requestAnimationFrame(tick)
        }),
      [ms, what],
    )

  // a paced swipe: the release reads speed as well as distance, so firing the
  // moves in a tight loop would make every pull an infinitely fast flick
  const swipe = async (x, y, dy, { steps = 14, ms = 22, dx = 0 } = {}) => {
    await touch('touchStart', x, y)
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', x + Math.round((dx * i) / steps), y + Math.round((dy * i) / steps))
      await page.waitForTimeout(ms)
    }
    await page.waitForTimeout(110)
    const during = await state()
    // the sampler starts before the finger lifts, so the first frame of the
    // settle is in the record
    const frames = sample(650, dx ? 'deck' : 'sheet')
    await page.waitForTimeout(16)
    await touch('touchEnd', x + dx, y + dy)
    const motion = await frames
    return { during, motion, after: await state() }
  }
  // the largest step the settle may take between two frames; a snapped detent
  // is the whole height difference (22dvh, ~200px), a clean settle stays
  // under a tenth of that
  const JUMP = 40

  const open = async () => {
    if (await page.evaluate(() => !!document.querySelector('dialog[open]'))) return true
    const btn = page.getByRole('button', { name: /Details zu|Details for/ }).first()
    if (!(await btn.count().catch(() => 0))) return false
    await btn.click({ timeout: 8000 }).catch(() => {})
    await page.waitForSelector('dialog[open]', { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(700)
    return page.evaluate(() => !!document.querySelector('dialog[open].dialog-sheet'))
  }

  const geo = () =>
    page.evaluate(() => {
      const d = [...document.querySelectorAll('dialog[open]')].pop()
      const r = d.getBoundingClientRect()
      // well inside the content, deliberately NOT the grabber: the grabber sits
      // outside the scrolling box and was the one place that always worked
      return { x: Math.round(r.x + r.width / 2), face: Math.round(r.y + 120), h: Math.round(r.height) }
    })

  await page.goto(`${BASE}/watches`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  if (!(await open())) {
    bad(`${tag}: kein Sheet-Dialog erreichbar`)
    await ctx.close()
    continue
  }

  const rest = await state()
  if (Math.abs(rest.h / rest.vh - OPENING) > 0.02)
    bad(`${tag}: öffnet auf ${((rest.h / rest.vh) * 100).toFixed(1)}%, erwartet ${OPENING * 100}%`)

  // the height difference between the two detents, for the pulls below
  const span = Math.round(rest.vh * (FULL - OPENING))

  // 1 - a short pull on the face follows the finger and springs back
  let g = await geo()
  let r = await swipe(g.x, g.face, 110)
  if (!/translate3d\(0(px)?, 1[01]\d/.test(r.during.transform || ''))
    bad(`${tag}: kurzer Zug auf der Fläche bewegt nichts (transform "${r.during.transform}")`)
  else if (!r.after.open) bad(`${tag}: 110px-Zug hat geschlossen`)
  else if (r.after.transform) bad(`${tag}: federt nicht zurück (transform "${r.after.transform}")`)
  else if (r.motion.max > JUMP) bad(`${tag}: Rückfedern springt um ${r.motion.max}px in einem Frame`)
  else good(`kurzer Zug auf der Fläche folgt und federt zurück (max ${r.motion.max}px/Frame)`)
  // the backdrop dims with the pull and is dark again once the sheet is back
  if (!(r.during.backdrop < 0.95)) bad(`${tag}: Backdrop dimmt beim Zug nicht mit (opacity ${r.during.backdrop})`)
  else if (r.after.backdrop !== 1) bad(`${tag}: Backdrop kommt nach dem Zug nicht zurück (opacity ${r.after.backdrop})`)
  else good(`Backdrop folgt dem Zug (opacity ${r.during.backdrop.toFixed(2)} -> ${r.after.backdrop})`)

  // 2 - a long pull from the opening height dismisses
  await open()
  g = await geo()
  r = await swipe(g.x, g.face, Math.round(g.h * 0.25) + 70)
  if (r.after.open) bad(`${tag}: langer Zug auf der Fläche schliesst nicht`)
  else good('langer Zug auf der Fläche schliesst')

  // 3 - a pull up follows the finger, and past the midpoint between the two
  //     heights the release opens the sheet to its full height - without a
  //     jump, since the height and the transform settle on one curve
  await open()
  g = await geo()
  r = await swipe(g.x, g.face, -Math.round(span / 2) - 40)
  if (r.during.expanded) bad(`${tag}: Zug nach oben springt unter dem Finger auf volle Höhe (transform "${r.during.transform}")`)
  else if (!/translate3d\(0(px)?, -/.test(r.during.transform || ''))
    bad(`${tag}: Zug nach oben folgt dem Finger nicht (transform "${r.during.transform}")`)
  else if (!r.after.expanded) bad(`${tag}: Zug nach oben öffnet nicht`)
  else if (Math.abs(r.after.h / r.after.vh - FULL) > 0.015)
    bad(`${tag}: nach oben auf ${((r.after.h / r.after.vh) * 100).toFixed(1)}%, erwartet ${FULL * 100}%`)
  else if (r.motion.max > JUMP) bad(`${tag}: Öffnen auf volle Höhe springt um ${r.motion.max}px in einem Frame`)
  else good(`Zug nach oben folgt und öffnet auf ${((r.after.h / r.after.vh) * 100).toFixed(1)}% (max ${r.motion.max}px/Frame)`)

  // 4a - from the full height a short slow pull is not a step back: the
  //      threshold is half the height difference, not a fixed few pixels
  g = await geo()
  r = await swipe(g.x, g.face, 60)
  if (!r.after.open) bad(`${tag}: 60px-Zug aus voller Höhe schliesst`)
  else if (!r.after.expanded) bad(`${tag}: 60px-Zug aus voller Höhe klappt schon ein (Schwelle ist ${Math.round(span / 2)}px)`)
  else if (r.after.transform) bad(`${tag}: kurzer Zug aus voller Höhe federt nicht zurück (transform "${r.after.transform}")`)
  else good('kurzer Zug aus voller Höhe federt zurück')

  // 4 - from the full height a pull past the midpoint gives the opening
  //     height back; the top edge must not jump when the height changes
  g = await geo()
  r = await swipe(g.x, g.face, Math.round(span / 2) + 40)
  if (!r.after.open) bad(`${tag}: Zug nach unten aus voller Höhe schliesst statt einzuklappen`)
  else if (r.after.expanded) bad(`${tag}: klappt nicht auf die Öffnungshöhe zurück`)
  else if (r.motion.max > JUMP) bad(`${tag}: Einklappen springt um ${r.motion.max}px in einem Frame (${r.motion.from} -> ${r.motion.to})`)
  else good(`Zug nach unten aus voller Höhe klappt ein ohne Sprung (max ${r.motion.max}px/Frame)`)

  // 5 - and the next one from there does dismiss
  g = await geo()
  r = await swipe(g.x, g.face, Math.round(g.h * 0.25) + 70)
  if (r.after.open) bad(`${tag}: zweiter Zug nach unten schliesst nicht`)
  else good('zweiter Zug schliesst')

  // 5b - one long pull from the full height - past the opening height and a
  //      dismissal's distance beyond it - closes in one go
  await open()
  g = await geo()
  await swipe(g.x, g.face, -Math.round(span / 2) - 40)
  g = await geo()
  r = await swipe(g.x, g.face, span + Math.round((g.h - span) * 0.25) + 60, { steps: 20 })
  if (r.after.open) bad(`${tag}: langer Zug aus voller Höhe schliesst nicht in einem Zug (expanded ${r.after.expanded})`)
  else good('ein langer Zug aus voller Höhe schliesst direkt')

  // 6 - inside scrolled content the content scrolls and the sheet stays put
  await open()
  g = await geo()
  await swipe(g.x, g.face, -90)
  await page.waitForTimeout(400)
  const sc = await page.evaluate(() => {
    const d = [...document.querySelectorAll('dialog[open]')].pop()
    const s = [...d.querySelectorAll('*')].find(
      (e) => e.scrollHeight > e.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY),
    )
    if (!s) return null
    s.scrollTop = 160
    const r = s.getBoundingClientRect()
    return { top: s.scrollTop, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  if (!sc || sc.top < 50) console.log('  – kein gescrollter Bereich in diesem Dialog, Regel nicht prüfbar')
  else {
    await page.waitForTimeout(260) // the hook ignores a press right after a scroll
    r = await swipe(sc.x, sc.y, 100)
    if (r.during.transform) bad(`${tag}: gescrollter Bereich - das Sheet zieht mit ("${r.during.transform}")`)
    else if (!r.after.open) bad(`${tag}: gescrollter Bereich - das Sheet hat geschlossen`)
    else good(`gescrollter Bereich: Sheet bleibt stehen, scrollTop ${sc.top} -> ${r.during.scrollTop}`)
  }

  // 7 - the calendar deck: a second swipe that lands while the first is still
  //     sliding must take the deck over where it is, not snap it back, and
  //     the turn in flight must not land under the finger
  await page.goto(`${BASE}/watches?view=calendar`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  const deck = await page.evaluate(() => {
    // the innermost swipe zone with a day heading: the calendar's deck
    const z = [...document.querySelectorAll('[style*="touch-action"]')].reverse().find((el) => el.querySelector('h3'))
    if (!z) return null
    const r = z.getBoundingClientRect()
    const head = () => z.querySelector('h3')?.textContent ?? ''
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 200)), w: Math.round(r.width), head: head() }
  })
  if (!deck) console.log('  – kein Kalender-Deck auf der Seite, Regel nicht prüfbar')
  else {
    const heading = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll('[style*="touch-action"]')]
            .reverse()
            .find((el) => el.querySelector('h3'))
            ?.querySelector('h3')?.textContent ?? '',
      )
    const swipeX = async (dx) => {
      await touch('touchStart', deck.x, deck.y)
      for (let i = 1; i <= 8; i++) {
        await touch('touchMove', deck.x + Math.round((dx * i) / 8), deck.y)
        await page.waitForTimeout(16)
      }
      await touch('touchEnd', deck.x + dx, deck.y)
    }
    const before = deck.head
    // the reference: two swipes with the deck at rest in between land two
    // pages on. The quick pair below has to land on the same page - a turn
    // in flight that is lost to the second swipe shows up here as one page
    await swipeX(-Math.round(deck.w * 0.5))
    await page.waitForTimeout(600)
    await swipeX(-Math.round(deck.w * 0.5))
    await page.waitForTimeout(600)
    const slow = await heading()
    await page.goto(`${BASE}/watches?view=calendar`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    // first swipe, then the second lands ~80ms into the 200ms slide
    const frames = sample(900, 'deck')
    await swipeX(-Math.round(deck.w * 0.5))
    await page.waitForTimeout(80)
    await swipeX(-Math.round(deck.w * 0.5))
    const motion = await frames
    await page.waitForTimeout(500)
    const after = await heading()
    if (motion.max > deck.w / 4) bad(`${tag}: Deck springt um ${motion.max}px in einem Frame bei zwei schnellen Wischern`)
    else if (slow === before) bad(`${tag}: zwei Wischer haben die Seite nicht gewechselt ("${before}")`)
    else if (after !== slow) bad(`${tag}: zwei schnelle Wischer landen auf "${after}", zwei langsame auf "${slow}" - ein Seitenwechsel ging verloren`)
    else good(`zwei schnelle Wischer im Kalender ohne Sprung (max ${motion.max}px/Frame): "${before}" -> "${after}"`)
  }

  await ctx.close()
}
await browser.close()

console.log(
  findings.length
    ? `\n${findings.length} Befunde:\n` + findings.map((f) => '  ' + f).join('\n')
    : `\n✓ ${VIEWPORTS.length} Viewports, Gesten wie erwartet: keine Befunde`,
)
process.exitCode = findings.length ? 1 : 0
