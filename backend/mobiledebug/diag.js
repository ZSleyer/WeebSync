// Mobile debugging aid, compiled into `go build -tags mobiledebug` builds
// only - never into a release. Two buttons on every page: "diag" shows the
// viewport, safe-area and shell measurements of this device, "upload" sends
// screenshots picked from the photo library. Measurements also go to the
// server on load and on every page change; both land in
// <data>/mobile-debug/ for reading on the development machine.
;(() => {
  const probe = (css) => {
    const d = document.createElement('div')
    d.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;visibility:hidden;' + css
    document.body.appendChild(d)
    const cs = getComputedStyle(d)
    const out = { h: d.getBoundingClientRect().height, pt: cs.paddingTop, pb: cs.paddingBottom }
    d.remove()
    return out
  }
  const rect = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return 'none'
    const r = e.getBoundingClientRect()
    return `top ${Math.round(r.top)} bottom ${Math.round(r.bottom)} h ${Math.round(r.height)}`
  }
  const report = () => {
    const v = window.visualViewport
    const tabs = document.querySelector('.ws-tabs')?.parentElement
    const lines = {
      ua: navigator.userAgent,
      standalone: `${navigator.standalone} / ${matchMedia('(display-mode: standalone)').matches}`,
      screen: `${screen.width}x${screen.height} @${devicePixelRatio}`,
      inner: `${innerWidth}x${innerHeight}`,
      docClient: document.documentElement.clientHeight,
      visual: v ? `${Math.round(v.height)} off ${Math.round(v.offsetTop)}` : '-',
      '100vh': probe('height:100vh').h,
      '100dvh': probe('height:100dvh').h,
      '100svh': probe('height:100svh').h,
      '100lvh': probe('height:100lvh').h,
      'safe top': probe('padding-top:env(safe-area-inset-top)').pt,
      'safe bottom': probe('padding-bottom:env(safe-area-inset-bottom)').pb,
      '--safe-b': probe('padding-bottom:var(--safe-b)').pb,
      shell: rect('.app-shell'),
      header: rect('header.ws-top'),
      main: rect('.app-shell > main'),
      tabs: rect('.ws-tabs'),
      'tab bar': tabs ? `${rect('.ws-tabs')} pb ${getComputedStyle(tabs).paddingBottom}` : 'none',
      'live wrap': rect('.ws-live-wrap'),
      'live pill': rect('.ws-live-wrap > .t-live'),
      'to-top wrap': rect('.t-totop-wrap'),
      'to-top': rect('.t-totop'),
      'main scroll': (() => {
        const m = document.querySelector('.app-shell > main')
        return m ? `top ${Math.round(m.scrollTop)} of ${m.scrollHeight} pb ${getComputedStyle(m).paddingBottom}` : 'none'
      })(),
      dialog: rect('dialog[open]'),
      // everything pinned to the viewport, where it sits
      fixed: [...document.querySelectorAll('body *')]
        .filter((e) => getComputedStyle(e).position === 'fixed' && e.getBoundingClientRect().height > 0 && !e.closest('[data-mobile-debug]'))
        .slice(0, 12)
        .map((e) => {
          const r = e.getBoundingClientRect()
          return `\n  ${e.tagName.toLowerCase()}.${String(e.className).split(' ').slice(0, 2).join('.')} top ${Math.round(r.top)} bottom ${Math.round(r.bottom)} left ${Math.round(r.left)} right ${Math.round(r.right)}`
        })
        .join(''),
      // anything wider than the screen
      overflow: [...document.querySelectorAll('body *')]
        .filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('[data-mobile-debug]'))
        .slice(0, 6)
        .map((e) => `\n  ${e.tagName.toLowerCase()}.${String(e.className).split(' ').slice(0, 2).join('.')} right ${Math.round(e.getBoundingClientRect().right)}`)
        .join(''),
    }
    return Object.entries(lines)
      .map(([k, val]) => `${k}: ${val}`)
      .join('\n')
  }
  const send = (why) =>
    fetch('/mobile-debug/report', { method: 'POST', body: `${why} ${location.pathname}\n${report()}` }).catch(() => {})

  const button = (label, top, bg) => {
    const b = document.createElement('button')
    b.textContent = label
    b.dataset.mobileDebug = ""
    b.style.cssText = `position:fixed;z-index:99999;right:6px;top:${top};padding:6px 10px;font:600 13px system-ui;background:${bg};color:#000;border:0;border-radius:8px`
    return b
  }
  const diag = button('diag', '45%', '#ffd400')
  const pane = document.createElement('pre')
  pane.dataset.mobileDebug = ""
  pane.style.cssText =
    'position:fixed;z-index:99998;left:8px;right:8px;top:12%;margin:0;padding:12px;font:12px/1.35 ui-monospace,monospace;background:#ffd400;color:#000;border-radius:10px;white-space:pre-wrap;display:none'
  diag.onclick = () => {
    pane.textContent = report()
    pane.style.display = pane.style.display === 'none' ? 'block' : 'none'
    send('tap')
  }

  const up = button('upload', 'calc(45% + 40px)', '#4fd1c5')
  const pick = document.createElement('input')
  pick.type = 'file'
  pick.accept = 'image/*'
  pick.multiple = true
  pick.style.display = 'none'
  up.onclick = () => pick.click()
  pick.onchange = async () => {
    let ok = 0
    up.textContent = '…'
    for (const f of pick.files) {
      const r = await fetch('/mobile-debug/upload', { method: 'POST', headers: { 'Content-Type': f.type }, body: f }).catch(() => null)
      if (r?.ok) ok++
    }
    up.textContent = `✓ ${ok}/${pick.files.length}`
    pick.value = ''
    setTimeout(() => (up.textContent = 'upload'), 4000)
  }

  let last = ''
  addEventListener('load', () => {
    document.body.append(diag, pane, up, pick)
    // a page of the app reports once it has laid out, and so does a dialog,
    // which covers the diag button while it is open
    let dialogs = 0
    setInterval(() => {
      if (location.pathname !== last) {
        last = location.pathname
        setTimeout(() => send('page'), 1500)
      }
      const open = document.querySelectorAll('dialog[open]').length
      if (open > dialogs) setTimeout(() => send('dialog'), 800)
      dialogs = open
    }, 500)
  })
})()
