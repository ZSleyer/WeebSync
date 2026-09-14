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
        scrollTop: s ? s.scrollTop : null,
      }
    })

  // a paced swipe: the release reads speed as well as distance, so firing the
  // moves in a tight loop would make every pull an infinitely fast flick
  const swipe = async (x, y, dy, { steps = 14, ms = 22 } = {}) => {
    await touch('touchStart', x, y)
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', x, y + Math.round((dy * i) / steps))
      await page.waitForTimeout(ms)
    }
    await page.waitForTimeout(110)
    const during = await state()
    await touch('touchEnd', x, y + dy)
    await page.waitForTimeout(600)
    return { during, after: await state() }
  }

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

  // 1 - a short pull on the face follows the finger and springs back
  let g = await geo()
  let r = await swipe(g.x, g.face, 110)
  if (!/translate3d\(0(px)?, 1[01]\d/.test(r.during.transform || ''))
    bad(`${tag}: kurzer Zug auf der Fläche bewegt nichts (transform "${r.during.transform}")`)
  else if (!r.after.open) bad(`${tag}: 110px-Zug hat geschlossen`)
  else if (r.after.transform) bad(`${tag}: federt nicht zurück (transform "${r.after.transform}")`)
  else good('kurzer Zug auf der Fläche folgt und federt zurück')

  // 2 - a long pull from the opening height dismisses
  await open()
  g = await geo()
  r = await swipe(g.x, g.face, Math.round(g.h * 0.25) + 70)
  if (r.after.open) bad(`${tag}: langer Zug auf der Fläche schliesst nicht`)
  else good('langer Zug auf der Fläche schliesst')

  // 3 - a pull up opens the sheet to its full height
  await open()
  g = await geo()
  r = await swipe(g.x, g.face, -90)
  if (!r.after.expanded) bad(`${tag}: Zug nach oben öffnet nicht`)
  else if (Math.abs(r.after.h / r.after.vh - FULL) > 0.015)
    bad(`${tag}: nach oben auf ${((r.after.h / r.after.vh) * 100).toFixed(1)}%, erwartet ${FULL * 100}%`)
  else good(`Zug nach oben öffnet auf ${((r.after.h / r.after.vh) * 100).toFixed(1)}%`)

  // 4 - from the full height a pull down gives the opening height back
  g = await geo()
  r = await swipe(g.x, g.face, Math.round(g.h * 0.25) + 70)
  if (!r.after.open) bad(`${tag}: Zug nach unten aus voller Höhe schliesst statt einzuklappen`)
  else if (r.after.expanded) bad(`${tag}: klappt nicht auf die Öffnungshöhe zurück`)
  else good('Zug nach unten aus voller Höhe klappt ein statt zu schliessen')

  // 5 - and the next one from there does dismiss
  g = await geo()
  r = await swipe(g.x, g.face, Math.round(g.h * 0.25) + 70)
  if (r.after.open) bad(`${tag}: zweiter Zug nach unten schliesst nicht`)
  else good('zweiter Zug schliesst')

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

  await ctx.close()
}
await browser.close()

console.log(
  findings.length
    ? `\n${findings.length} Befunde:\n` + findings.map((f) => '  ' + f).join('\n')
    : `\n✓ ${VIEWPORTS.length} Viewports, Gesten wie erwartet: keine Befunde`,
)
process.exitCode = findings.length ? 1 : 0
