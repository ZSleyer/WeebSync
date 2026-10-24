// Functional pass: drives real user flows through the UI of a running
// instance and reports every step PASS, FAIL or SKIP with a reason. The other
// passes in this folder judge how the app looks; this one judges whether it
// still does what it did - sign-in and TOTP, servers, the file browser and
// trash, downloads, watches, the rename tools, every settings page, the
// second user's permissions. Run it against two builds (main and a branch)
// and diff the JSON it writes: a step that passes on one and fails on the
// other is a regression.
//
// API calls only set preconditions up or check results; the action itself is
// always a click, a key or a typed value. A step also fails on an uncaught
// page error, a console error, or a 5xx response while it ran.
//
//   WS_EMAIL=... WS_PASSWORD=... \
//   WS_SFTP_HOST=localhost WS_SFTP_PORT=2222 WS_SFTP_USER=... WS_SFTP_PASS=... \
//   [WS_SETUP_TOKEN=...] [WS_JELLYFIN_URL=... WS_JELLYFIN_KEY=...] \
//   node tools/ui-audit/features.mjs --base http://localhost:8091 [--browsers chromium] \
//     [--out /tmp/features] [--tag main] [--only regex]
//
// The instance should be fresh (or at least a scratch one): the run creates
// the admin account through the setup wizard when there is none, adds the
// SFTP test server, downloads a few small files, makes and deletes a second
// user, and toggles settings. Never point it at an instance with real data.
import { chromium, firefox } from 'playwright'
import { createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch } from './auth.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : dflt
}
const BASE = arg('base', 'http://localhost:8099').replace(/\/$/, '')
const OUT = arg('out', './e2e-shots')
const TAG = arg('tag', new URL(BASE).port || 'run')
const ONLY = arg('only', '') ? new RegExp(arg('only', ''), 'i') : null
const BROWSERS = arg('browsers', 'chromium').split(',')
const ENGINES = { chromium, firefox }

const EMAIL = process.env.WS_EMAIL || ''
const PASSWORD = process.env.WS_PASSWORD || ''
const SETUP_TOKEN = process.env.WS_SETUP_TOKEN || ''
const SFTP = {
  host: process.env.WS_SFTP_HOST || '',
  port: Number(process.env.WS_SFTP_PORT || 22),
  user: process.env.WS_SFTP_USER || '',
  pass: process.env.WS_SFTP_PASS || '',
}
const JELLYFIN = { url: process.env.WS_JELLYFIN_URL || '', key: process.env.WS_JELLYFIN_KEY || '' }
// the second account; a test address, never a real one
const USER2 = { email: 'takina@da.jp', password: 'Inoue-Takina-2026!' }

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ──────────────────────────────────
const base32 = (s) => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += abc.indexOf(c).toString(2).padStart(5, '0')
  const out = []
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(out)
}
const totp = (secret, t = Date.now()) => {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / 30)))
  const h = createHmac('sha1', base32(secret)).update(msg).digest()
  const o = h[h.length - 1] & 0xf
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0')
}
// A code with at least `min` seconds of its window left, so a check that
// takes a moment does not straddle the step, and from a window no earlier
// call used: the server refuses a code it has already seen once.
let lastWindow = -1
const freshTotp = async (secret, min = 8) => {
  for (;;) {
    const now = Date.now() / 1000
    const left = 30 - (now % 30)
    if (Math.floor(now / 30) !== lastWindow && left >= min) break
    await new Promise((r) => setTimeout(r, left * 1000 + 300))
  }
  lastWindow = Math.floor(Date.now() / 1000 / 30)
  return totp(secret)
}

// ── step harness ────────────────────────────────────────────────────────────
class Skip extends Error {}
const skip = (why) => {
  throw new Skip(why)
}
const must = (cond, why) => {
  if (!cond) throw new Error(why)
}

const results = []
let watch = null // the page(s) whose errors count for the running step

function observe(page, bucket) {
  if (process.env.WS_TRACE)
    page.on('response', async (r) => {
      if (!r.url().includes('/api/')) return
      const sc = (await r.allHeaders().catch(() => ({})))['set-cookie']
      // cookie names only: the values are session secrets
      const set = sc ? sc.split('\n').map((c) => c.split('=')[0]).join(',') : ''
      console.log('TRACE', r.status(), r.request().method(), new URL(r.url()).pathname, set ? `sets ${set}` : '')
    })
  page.on('pageerror', (e) => bucket.errors.push(`pageerror: ${e.message.split('\n')[0]}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    // a failed request also logs "Failed to load resource"; the response
    // listener judges those by status (a 401 or 403 is often the point)
    if (/Failed to load resource/.test(text)) return
    // Firefox reports a font request that a navigation or a closing page
    // aborted (NS_BINDING_ABORTED) as an error; nothing failed there
    if (/downloadable font: download failed.*status=2152398850/.test(text)) return
    bucket.errors.push(`console: ${text.slice(0, 200)}`)
  })
  page.on('response', (r) => {
    if (r.status() >= 500 && !bucket.allow5xx.some((re) => re.test(r.url())))
      bucket.errors.push(`HTTP ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`)
  })
}

// 5xx answers that are the documented reply to a missing integration, not a
// failure: the series page asks for the linked Plex show either way
const ALLOW_5XX = [/\/api\/watches\/\d+\/plex-show$/]

async function step(name, fn) {
  if (ONLY && !ONLY.test(name)) return
  watch.errors.length = 0
  watch.allow5xx = [...ALLOW_5XX]
  const t0 = Date.now()
  let status = 'PASS'
  let reason = ''
  try {
    const r = await fn()
    if (typeof r === 'string') reason = r
  } catch (e) {
    if (e instanceof Skip) {
      status = 'SKIP'
      reason = e.message
    } else {
      status = 'FAIL'
      reason = (e?.message || String(e)).split('\n')[0].slice(0, 240)
      if (process.env.WS_DEBUG) console.log(e?.message)
    }
  }
  // let late responses of the step land before judging
  await new Promise((r) => setTimeout(r, 150))
  if (status !== 'SKIP' && watch.errors.length) {
    status = 'FAIL'
    reason = [reason, ...new Set(watch.errors)].filter(Boolean).join(' | ').slice(0, 400)
  }
  if (status === 'FAIL' && watch.page) {
    const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    await watch.page.screenshot({ path: `${OUT}/${TAG}-${slug}.png` }).catch(() => {})
    if (process.env.WS_DEBUG)
      console.log(await watch.page.locator('body').ariaSnapshot().catch(() => ''))
  }
  results.push({ step: name, status, reason, ms: Date.now() - t0 })
  console.log(`${status.padEnd(4)} ${name}${reason ? ` - ${reason}` : ''}`)
}

// ── helpers ─────────────────────────────────────────────────────────────────
const api = async (page, method, path, body, headers = {}) =>
  page.evaluate(
    async ({ method, path, body, headers }) => {
      const r = await fetch(path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      let data = null
      const text = await r.text()
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
      return { status: r.status, data }
    },
    { method, path, body, headers },
  )

const go = async (page, path) => {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const visible = (loc, timeout = 6000) => loc.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false)
// a toast or inline error the app shows when an action failed
const errorShown = async (page) => {
  const alerts = page.locator('[role=alert]')
  const n = await alerts.count()
  const texts = []
  for (let i = 0; i < n; i++) {
    const t = (await alerts.nth(i).innerText().catch(() => '')).trim()
    if (t) texts.push(t)
  }
  return texts.join(' / ')
}

async function loginForm(page, email, password) {
  await go(page, '/')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.locator('form').getByRole('button', { name: /^Sign in$/ }).click()
}
const signedIn = (page) => visible(page.locator('nav, [role=navigation]').filter({ hasText: /Files|Dashboard|Today/ }), 8000)
const me = async (page) => (await api(page, 'GET', '/api/auth/me')).status === 200

// the second-factor form submits itself once six digits are in; the button
// is only there for a recovery code
async function enterCode(page, code) {
  await page.locator('#totp-code').fill(code)
  await sleep(700)
  const btn = page.getByRole('button', { name: 'Confirm' })
  if ((await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false)))
    await btn.click({ timeout: 2000 }).catch(() => {})
}

async function logoutUi(page) {
  await go(page, '/')
  await page.locator('.ws-acct-box button').last().click()
  // the entries grow out of the account button: until the fold has opened,
  // "Log out" sits under the button itself and a click there closes the menu
  await page
    .waitForFunction(() => {
      const f = document.querySelector('.ws-acct-box .ws-acct-fold')
      return !!f && !f.inert && f.getBoundingClientRect().height > 100
    }, null, { timeout: 5000 })
    .catch(() => {})
  await sleep(300)
  await page.getByRole('button', { name: /^Sign out$|^Log out$|^Logout$/ }).click()
  // the app clears its push subscription before it signs out; leaving the
  // page earlier would cancel the sign-out
  await page.locator('#password').waitFor({ timeout: 6000 }).catch(() => {})
}

// ── the flows ───────────────────────────────────────────────────────────────
async function run(engine) {
  const browser = await launch(ENGINES[engine])
  const newCtx = async () => {
    const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } })
    await ctx.addInitScript(() => localStorage.setItem('weebsync.locale', 'en'))
    return ctx
  }
  const ctx = await newCtx()
  const page = await ctx.newPage()
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  watch = { errors: [], allow5xx: [], page }
  observe(page, watch)
  const st = {} // what earlier steps left for later ones

  // ── setup and sign-in ──
  await step('setup: wizard on a fresh instance', async () => {
    await go(page, '/')
    const cfg = await api(page, 'GET', '/api/auth/config')
    if (!cfg.data?.setupNeeded) skip('instance already set up')
    if (!SETUP_TOKEN) skip('WS_SETUP_TOKEN not set')
    await page.getByLabel('Setup code').fill(SETUP_TOKEN)
    await page.getByLabel('Email', { exact: true }).fill(EMAIL)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Password again').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()
    // the rest of the wizard: skip what can be skipped, continue otherwise
    for (let i = 0; i < 10; i++) {
      await sleep(600)
      const open = page.getByRole('button', { name: 'Open WeebSync' })
      if (await open.isVisible().catch(() => false)) {
        await open.click()
        break
      }
      const skipBtn = page.getByRole('button', { name: /^Skip$/ })
      if (await skipBtn.isVisible().catch(() => false)) {
        await skipBtn.click()
        continue
      }
      const cont = page.getByRole('button', { name: /^Continue$|^Save and continue$|^Next$|^Finish setup$/ })
      if (await cont.first().isVisible().catch(() => false)) {
        await cont.first().click()
        continue
      }
      const err = await errorShown(page)
      throw new Error(`wizard stuck${err ? `: ${err}` : ''}`)
    }
    must(await signedIn(page), 'app shell not shown after the wizard')
  })

  // Precondition: the sign-in limiter allows five attempts a minute, and this
  // run signs in a dozen times. The loopback address goes on the trusted list
  // (Settings, Security), which the limiter skips.
  {
    await go(page, '/')
    if (!(await me(page))) await api(page, 'POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })
    const cur = await api(page, 'GET', '/api/settings')
    if (cur.status === 200 && !/127\.0\.0\.1/.test(cur.data.trustedNetworks || '')) {
      const r = await api(page, 'PUT', '/api/settings', { ...cur.data, trustedNetworks: '127.0.0.1/32, ::1/128' })
      if (r.status >= 300) console.log(`note: could not trust loopback (HTTP ${r.status}), sign-ins may be throttled`)
    }
    await api(page, 'POST', '/api/auth/ratelimit/reset', {})
  }

  await step('auth: wrong password refused', async () => {
    await ctx.clearCookies()
    await loginForm(page, EMAIL, PASSWORD + 'x')
    await sleep(1200)
    must(!(await me(page)), 'signed in with a wrong password')
    must(await errorShown(page), 'no error shown for the wrong password')
  })

  await step('auth: login with password', async () => {
    await ctx.clearCookies()
    await loginForm(page, EMAIL, PASSWORD)
    must(await signedIn(page), 'app shell not shown after login')
    must(await me(page), '/api/auth/me not 200 after login')
  })

  await step('auth: logout returns to login', async () => {
    await logoutUi(page)
    must(await visible(page.locator('#password'), 8000), 'login form not shown after logout')
    must(!(await me(page)), 'session still valid after logout')
  })

  await step('auth: login again', async () => {
    await loginForm(page, EMAIL, PASSWORD)
    must(await signedIn(page), 'app shell not shown after the second login')
  })

  // a partial run (--only) starts signed out: sign in without a step
  if (ONLY) {
    await go(page, '/')
    if (!(await me(page))) await api(page, 'POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })
  }

  // ── account: TOTP ──
  const totpPanel = () => page.getByRole('region', { name: 'Two-factor authentication (TOTP)' })
  await step('account: enable TOTP', async () => {
    await go(page, '/settings/account')
    const p = totpPanel()
    must(await visible(p), 'TOTP panel missing')
    await p.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await p.getByRole('button', { name: 'Enable' }).click()
    const secretEl = p.locator('.font-mono.break-all')
    must(await visible(secretEl), 'no TOTP secret shown')
    st.totpSecret = (await secretEl.innerText()).replace(/\s+/g, '')
    await p.getByLabel('Code from the app to confirm').fill(await freshTotp(st.totpSecret))
    await p.getByRole('button', { name: 'Confirm & enable' }).click()
    must(await visible(p.locator('.ws-codes li')), 'no recovery codes after confirming')
    await p.getByRole('button', { name: 'Close' }).click()
    const on = await api(page, 'GET', '/api/auth/totp')
    must(on.data?.enabled === true, 'TOTP not reported enabled')
  })

  await step('account: login with TOTP', async () => {
    if (!st.totpSecret) skip('TOTP was not enabled')
    await logoutUi(page)
    await loginForm(page, EMAIL, PASSWORD)
    must(await visible(page.locator('#totp-code')), 'no second-factor prompt')
    st.usedCode = await freshTotp(st.totpSecret, 12)
    await enterCode(page, st.usedCode)
    must(await signedIn(page), 'not signed in after the TOTP code')
  })

  await step('account: TOTP code reuse refused', async () => {
    if (!st.usedCode) skip('no TOTP login happened')
    await ctx.clearCookies()
    await loginForm(page, EMAIL, PASSWORD)
    must(await visible(page.locator('#totp-code')), 'no second-factor prompt')
    await enterCode(page, st.usedCode)
    await sleep(1500)
    must(!(await me(page)), 'the same code signed in twice')
    must(await errorShown(page), 'no error shown for the reused code')
    // a code of the next window gets in
    await enterCode(page, await freshTotp(st.totpSecret))
    must(await signedIn(page), 'a fresh code did not sign in')
  })

  await step('account: disable TOTP', async () => {
    if (!st.totpSecret) skip('TOTP was not enabled')
    await go(page, '/settings/account')
    const p = totpPanel()
    await p.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await p.getByRole('button', { name: 'Disable' }).click()
    await sleep(800)
    const on = await api(page, 'GET', '/api/auth/totp')
    must(on.data?.enabled === false, 'TOTP still enabled')
  })

  // ── servers ──
  const SERVER_NAME = 'E2E SFTP'
  // a partial run picks up what an earlier full run left behind
  if (ONLY && !ONLY.test('servers: add the SFTP test server')) {
    st.server = ((await api(page, 'GET', '/api/servers')).data || []).find((s) => s.name === SERVER_NAME)
    if (st.server) st.remoteDir = await findEpisodes(page, st.server.id)
    st.downloaded = ((await api(page, 'GET', '/api/downloads')).data || []).find(
      (d) => d.status === 'done' && st.remoteDir && d.remotePath === st.remoteDir.files[0].path,
    )
    st.watch = ((await api(page, 'GET', '/api/watches')).data || []).find((w) => w.localPath === '/e2e-watch')
  }
  const serverCard = () => page.locator('article.srv').filter({ hasText: SERVER_NAME })
  await step('servers: add the SFTP test server', async () => {
    if (!SFTP.host) skip('WS_SFTP_HOST not set')
    const list = await api(page, 'GET', '/api/servers')
    const old = (list.data || []).find((s) => s.name === SERVER_NAME)
    if (old) await api(page, 'DELETE', `/api/servers/${old.id}`)
    await go(page, '/settings/servers')
    await page.getByRole('button', { name: 'Add server' }).click()
    await page.getByLabel('Name', { exact: true }).fill(SERVER_NAME)
    await page.getByLabel('Host', { exact: true }).fill(SFTP.host)
    await page.getByLabel('Port', { exact: true }).fill(String(SFTP.port))
    await page.getByLabel('Username', { exact: true }).fill(SFTP.user)
    await page.getByLabel('Password', { exact: true }).fill(SFTP.pass)
    await page.getByLabel('Root path', { exact: true }).fill('/data')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    // a new SFTP server may stop at the host key right away
    await sleep(1500)
    const accept = page.getByRole('button', { name: 'Accept' })
    if (await accept.isVisible().catch(() => false)) {
      st.keyAcceptedOnSave = true
      await accept.click()
      await sleep(1000)
    }
    must(await visible(serverCard(), 8000), 'server not in the list after saving')
    const after = await api(page, 'GET', '/api/servers')
    st.server = (after.data || []).find((s) => s.name === SERVER_NAME)
    must(st.server, 'server not returned by /api/servers')
  })

  await step('servers: test connection (host key accept)', async () => {
    if (!st.server) skip('no server')
    await go(page, '/settings/servers')
    const card = serverCard()
    await card.getByRole('button', { name: 'Test', exact: true }).click()
    const accept = card.getByRole('button', { name: 'Accept' })
    const connected = card.getByText('Connected', { exact: true })
    await Promise.race([accept.waitFor({ timeout: 15000 }), connected.waitFor({ timeout: 15000 })]).catch(() => {})
    if (await accept.isVisible().catch(() => false)) {
      await accept.click()
    } else if (!st.keyAcceptedOnSave) {
      throw new Error('no host key prompt on the first connection')
    }
    must(await visible(connected, 15000), `no "Connected" badge: ${await errorShown(page)}`)
    const s = (await api(page, 'GET', '/api/servers')).data.find((x) => x.id === st.server.id)
    must(s?.hostKey, 'host key not pinned after accepting')
  })

  await step('servers: browse remote folders', async () => {
    if (!st.server) skip('no server')
    await go(page, `/files?server=${st.server.id}`)
    const rows = page.locator('.ws-cl-row')
    must(await visible(rows), 'remote root lists nothing')
    // the first folder at the root, then one level further
    const first = (await api(page, 'GET', `/api/servers/${st.server.id}/browse?path=/data`)).data.find((e) => e.isDir)
    must(first, 'no folder at the remote root')
    await page.getByRole('button', { name: first.name, exact: true }).click()
    const crumbs = page.getByRole('navigation', { name: 'Path' })
    must(await visible(crumbs.getByRole('button', { name: first.name, exact: true })), 'breadcrumb did not follow')
    must(await visible(rows), 'the opened folder lists nothing')
    // the folder with a few small episodes the download steps use, found
    // through the API so no server path is written down here
    st.remoteDir = await findEpisodes(page, st.server.id)
    must(st.remoteDir, 'no folder with three small video files on the test server')
    await go(page, `/files?server=${st.server.id}&path=${encodeURIComponent(st.remoteDir.path.replace(/^\//, ''))}`)
    must(await visible(page.getByRole('button', { name: st.remoteDir.files[0].name, exact: true })), 'deep link to a folder lists nothing')
  })

  // ── downloads (and the local folder picker's mkdir) ──
  const DL_DIR = 'e2e-dl'
  const openSync = async (file) => {
    await go(page, `/files?server=${st.server.id}&path=${encodeURIComponent(st.remoteDir.path.replace(/^\//, ''))}`)
    await page.getByRole('button', { name: file.name, exact: true }).click()
    await page.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: 'Download file' }).click()
    const dlg = page.getByRole('dialog', { name: `Sync ${file.name}` })
    must(await visible(dlg), 'sync dialog did not open')
    return dlg
  }
  const downloadOf = async (file) =>
    ((await api(page, 'GET', '/api/downloads')).data || []).filter((d) => d.remotePath === file.path).pop()
  const waitDownload = async (file, want, ms = 30000) => {
    const end = Date.now() + ms
    let d
    while (Date.now() < end) {
      d = await downloadOf(file)
      if (d && want.includes(d.status)) return d
      await sleep(400)
    }
    throw new Error(`download of ${file.name} is ${d ? d.status : 'missing'}, wanted ${want.join('/')}`)
  }

  await step('files: create a folder (mkdir in the target picker)', async () => {
    if (!st.remoteDir) skip('no remote folder')
    const dlg = await openSync(st.remoteDir.files[0])
    await dlg.getByRole('button', { name: 'Browse' }).click()
    await dlg.getByLabel('new folder…').fill(DL_DIR)
    await dlg.getByRole('button', { name: 'Create new folder' }).click()
    const made = dlg.getByRole('button', { name: DL_DIR, exact: true })
    must(await visible(made), 'new folder not listed in the picker')
    const local = await api(page, 'GET', '/api/browse/local?path=')
    must((local.data || []).some((e) => e.name === DL_DIR && e.isDir), 'folder missing from /api/browse/local')
    st.dlg = dlg
  })

  await step('downloads: queue a download and wait for it', async () => {
    if (!st.remoteDir) skip('no remote folder')
    const file = st.remoteDir.files[0]
    let dlg = st.dlg
    if (!dlg || !(await dlg.isVisible().catch(() => false))) {
      dlg = await openSync(file)
      await dlg.getByRole('button', { name: 'Browse' }).click()
    }
    // into the new folder: the picker's place is the target
    await dlg.getByRole('button', { name: DL_DIR, exact: true }).click()
    must(await visible(dlg.getByText(new RegExp(`Goes to: .*/${DL_DIR}`))), 'target did not follow the picker')
    await dlg.getByRole('button', { name: 'Download file' }).click()
    must(await dlg.waitFor({ state: 'hidden', timeout: 8000 }).then(() => true, () => false), 'dialog stayed open')
    const d = await waitDownload(file, ['done', 'error', 'canceled'])
    must(d.status === 'done', `download ended ${d.status}: ${d.error || ''}`)
    must(d.localPath.includes(`/${DL_DIR}/`), `landed outside the chosen folder: ${d.localPath}`)
    st.downloaded = d
  })

  await step('downloads: finished download in the history', async () => {
    if (!st.downloaded) skip('nothing downloaded')
    await go(page, '/history')
    const name = st.remoteDir.files[0].name
    const stem = name.replace(/\.[^.]+$/, '')
    must(await visible(page.getByText(stem.slice(0, 30), { exact: false }), 8000), 'download not listed on /history')
  })

  await step('downloads: pause, resume and cancel a second one', async () => {
    if (!st.remoteDir || !st.downloaded) skip('no first download')
    const file = st.remoteDir.files[1]
    // slow enough to act on: 40 KB/s, a 4 MiB file takes a while
    must((await api(page, 'PUT', '/api/downloads/ratelimit', { rateLimit: 40_000 })).status < 300, 'could not set the rate limit')
    try {
      const dlg = await openSync(file)
      // the folder used last is offered in the target field's list
      const target = dlg.getByRole('combobox', { name: 'Local target' })
      await target.click()
      await target.fill(DL_DIR)
      const opt = page.getByRole('option', { name: DL_DIR, exact: true })
      if (await visible(opt, 3000)) await opt.click()
      must(await visible(dlg.getByText(new RegExp(`Goes to: .*/${DL_DIR}`))), 'the target did not take the folder')
      await dlg.getByRole('button', { name: 'Download file' }).click()
      await waitDownload(file, ['running'], 15000)
      // the transfer sheet from the Today page
      await go(page, '/')
      await page.getByRole('button', { name: 'Details' }).first().click()
      const pause = page.getByRole('button', { name: /^Pause: / }).first()
      must(await visible(pause), 'no pause button in the transfer sheet')
      await pause.click()
      await waitDownload(file, ['paused'], 8000)
      const resume = page.getByRole('button', { name: /^Resume: / }).first()
      must(await visible(resume), 'no resume button after pausing')
      await resume.click()
      await waitDownload(file, ['running', 'queued'], 8000)
      // the queue: the running row's actions menu (judged in a step of its
      // own below), then its Cancel button
      await page.getByRole('button', { name: /Manage/ }).first().click()
      const row = page.getByRole('article').filter({ has: page.getByRole('heading', { name: file.name }) })
      must(await visible(row), 'running download not in the queue')
      const actions = row.getByRole('button', { name: `Actions for ${file.name}` })
      // the sheet scrolls smoothly: a click while it still glides lets the
      // scroll that follows close the menu at once, which no person does
      await actions.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
      await sleep(400)
      await actions.click()
      await sleep(400)
      st.rowMenu = await page.getByRole('menuitem', { name: 'Cancel' }).isVisible().catch(() => false)
      if (st.rowMenu) await page.keyboard.press('Escape')
      await row.getByRole('button', { name: 'Cancel', exact: true }).click()
      if (await visible(page.locator('.ws-confirm-foot'), 1500)) await confirmYes(page)
      const d = await waitDownload(file, ['canceled'], 8000)
      must(d.status === 'canceled', 'not canceled')
    } finally {
      await api(page, 'PUT', '/api/downloads/ratelimit', { rateLimit: 0 })
    }
  })

  await step('downloads: queue row actions menu stays open', async () => {
    if (st.rowMenu === undefined) skip('no running download got that far')
    must(st.rowMenu, 'the menu of a running row closed again right after opening')
  })

  // ── files: the local library ──
  const localList = async (dir) => (await api(page, 'GET', `/api/browse/local?path=${encodeURIComponent(dir)}`)).data || []
  await step('files: browse the local root', async () => {
    await go(page, '/files?source=local')
    if (!(await localList('')).length) skip('local library is empty (no download happened)')
    const dir = page.getByRole('button', { name: DL_DIR, exact: true })
    must(await visible(dir), `${DL_DIR} not listed at the local root`)
    await dir.click()
    must(
      await visible(page.getByRole('navigation', { name: 'Path' }).getByRole('button', { name: DL_DIR, exact: true })),
      'breadcrumb did not follow into the folder',
    )
  })

  await step('files: inline rename a file', async () => {
    if (!st.downloaded) skip('nothing downloaded')
    const name = st.downloaded.localPath.split('/').pop()
    const ext = name.slice(name.lastIndexOf('.'))
    await go(page, `/files?source=local&path=${DL_DIR}`)
    await page.getByRole('button', { name, exact: true }).click()
    await page.getByRole('button', { name: `Rename ${name}` }).click()
    const field = page.getByLabel(`New name for "${name}"`)
    must(await visible(field), 'no rename field')
    const typed = await field.inputValue()
    // the field holds the name without its type, or the whole name
    await field.fill(typed.endsWith(ext) ? `e2e-renamed${ext}` : 'e2e-renamed')
    await field.press('Enter')
    must(await visible(page.getByRole('button', { name: `e2e-renamed${ext}`, exact: true })), 'renamed file not listed')
    must((await localList(DL_DIR)).some((e) => e.name === `e2e-renamed${ext}`), 'rename not on disk')
    st.renamedFile = `/${DL_DIR}/e2e-renamed${ext}`
  })

  await step('files: inline rename a folder', async () => {
    const r = await api(page, 'POST', '/api/browse/local/mkdir', { path: '/e2e-scratch' })
    must(r.status < 300, `precondition mkdir failed: HTTP ${r.status}`)
    await go(page, '/files?source=local')
    // the folder's own row: its details panel holds the rename
    await page.getByRole('button', { name: 'Select e2e-scratch' }).click().catch(() => {})
    let btn = page.getByRole('button', { name: 'Rename e2e-scratch' })
    if (!(await visible(btn, 3000))) {
      // a click on a folder opens it; its "this folder" row selects it
      await page.getByRole('button', { name: 'e2e-scratch', exact: true }).click()
      await page.getByRole('button', { name: 'Select e2e-scratch' }).click()
      btn = page.getByRole('button', { name: 'Rename e2e-scratch' })
    }
    await btn.click()
    const field = page.getByLabel('New name for "e2e-scratch"')
    must(await visible(field), 'no rename field')
    await field.fill('e2e-scratch2')
    await field.press('Enter')
    await sleep(800)
    must((await localList('')).some((e) => e.name === 'e2e-scratch2'), 'folder rename not on disk')
  })

  await step('files: move to trash, restore from trash', async () => {
    if (!(await localList('')).some((e) => e.name === 'e2e-scratch2')) skip('no scratch folder')
    // Precondition through the API: the UI moves to the trash only from the
    // duplicates list and on upgrades, both of which need a matched library
    const r = await api(page, 'POST', '/api/suggestions/duplicates/trash', { path: '/e2e-scratch2' })
    must(r.status < 300, `could not trash the folder: HTTP ${r.status} ${JSON.stringify(r.data)}`)
    must(!(await localList('')).some((e) => e.name === 'e2e-scratch2'), 'folder still in place after trashing')
    await go(page, '/files/trash')
    const row = page.locator('li').filter({ hasText: 'e2e-scratch2' })
    must(await visible(row), 'trashed folder not listed on /files/trash')
    await row.getByRole('button', { name: /Restore/ }).click()
    await sleep(1000)
    must((await localList('')).some((e) => e.name === 'e2e-scratch2'), 'folder not back after restoring')
  })

  await step('files: empty trash (with confirm)', async () => {
    const a = await api(page, 'POST', '/api/suggestions/duplicates/trash', { path: '/e2e-scratch2' })
    must(a.status < 300, `could not trash the folder: HTTP ${a.status}`)
    if (st.renamedFile) await api(page, 'POST', '/api/suggestions/duplicates/trash', { path: st.renamedFile })
    await go(page, '/files/trash')
    must(await visible(page.locator('li').filter({ hasText: 'e2e-scratch2' })), 'trashed folder not listed')
    await page.getByRole('button', { name: 'Empty trash' }).first().click()
    const dlg = page.getByRole('alertdialog').or(page.getByRole('dialog'))
    must(await visible(dlg), 'no confirmation')
    await dlg.getByRole('button', { name: 'Empty trash' }).click()
    await sleep(1000)
    const left = (await api(page, 'GET', '/api/trash')).data || []
    must(left.length === 0, `trash still holds ${left.length} entr(ies)`)
    must(await visible(page.getByText('The trash is empty.')), 'page does not say the trash is empty')
  })

  // ── watches (auto-sync) ──
  const watchesOf = async () => (await api(page, 'GET', '/api/watches')).data || []
  await step('watches: create a watch on a remote folder', async () => {
    if (!st.remoteDir) skip('no remote folder')
    for (const w of await watchesOf()) if (w.localPath?.includes('e2e-watch')) await api(page, 'DELETE', `/api/watches/${w.id}`)
    const parts = st.remoteDir.path.split('/')
    const dirName = parts.pop()
    await go(page, `/files?server=${st.server.id}&path=${encodeURIComponent(parts.join('/').replace(/^\//, ''))}`)
    await page.getByRole('button', { name: `Select ${dirName}`, exact: true }).click()
    await page.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: 'Create auto-sync' }).click()
    const dlg = page.getByRole('dialog', { name: `Auto-sync: ${dirName}` })
    must(await visible(dlg), 'auto-sync dialog did not open')
    const target = dlg.getByRole('combobox', { name: 'Local target' })
    await target.fill('/e2e-watch')
    await target.press('Tab')
    await dlg.getByRole('button', { name: 'Save', exact: true }).click()
    must(await dlg.waitFor({ state: 'hidden', timeout: 8000 }).then(() => true, () => false), `dialog stayed open: ${await errorShown(page)}`)
    const w = (await watchesOf()).find((x) => x.remotePath === st.remoteDir.path)
    must(w, 'watch not returned by /api/watches')
    st.watch = w
  })

  // the series page of the one watch, through its tile on /watches
  const openWatch = async () => {
    await go(page, '/watches')
    const tile = page.locator('.w-tile').first()
    must(await visible(tile), 'no tile on /watches')
    await tile.click()
    const dlg = page.getByRole('dialog').filter({ has: page.getByRole('region', { name: 'Auto-sync' }) })
    must(await visible(dlg), 'series page did not open')
    return dlg
  }

  await step('watches: check now, episodes queued and explained', async () => {
    if (!st.watch) skip('no watch')
    const before = (await watchesOf()).find((x) => x.id === st.watch.id)
    await sleep(1100) // lastCheck has a resolution of a second
    const dlg = await openWatch()
    // its name sits in a live status inside the button, which some engines
    // leave out of the accessible name: found by its text
    await dlg.getByRole('button').filter({ hasText: 'Check now' }).first().click()
    const end = Date.now() + 20000
    let now
    while (Date.now() < end) {
      now = (await watchesOf()).find((x) => x.id === st.watch.id)
      if (now && now.lastCheck !== before.lastCheck) break
      await sleep(500)
    }
    must(now && now.lastCheck !== before.lastCheck, 'lastCheck did not move after "Check now"')
    const dls = ((await api(page, 'GET', '/api/downloads')).data || []).filter((d) => d.localPath.includes('/e2e-watch/'))
    must(dls.length > 0 || now.lastQueued > 0, 'the watch queued no episode')
    const region = dlg.getByRole('region', { name: 'Auto-sync' })
    const text = (await region.innerText()).trim()
    must(text.length > 20, 'no explanation in the auto-sync section')
    must(!/error|failed/i.test(now.lastResult || ''), `last result: ${now.lastResult}`)
  })

  await step('watches: edit the watch', async () => {
    if (!st.watch) skip('no watch')
    const dlg = await openWatch()
    await dlg.getByRole('button', { name: 'Edit', exact: true }).click()
    // the form takes the series page's place, under its own heading
    const heading = page.getByRole('heading', { name: 'Edit auto-sync' })
    must(await visible(heading), 'edit form did not open')
    const ed = page.getByRole('dialog').filter({ has: heading })
    await ed.getByLabel('Count from a specific episode number (optional)').fill('2')
    await ed.getByRole('button', { name: 'Save', exact: true }).click()
    must(await heading.waitFor({ state: 'hidden', timeout: 8000 }).then(() => true, () => false), `edit form stayed open: ${await errorShown(page)}`)
    const w = (await watchesOf()).find((x) => x.id === st.watch.id)
    must(w?.fromEpisode === 2, `fromEpisode is ${w?.fromEpisode}, wanted 2`)
  })

  await step('watches: delete via the actions menu', async () => {
    if (!st.watch) skip('no watch')
    const dlg = await openWatch()
    await dlg.getByRole('button', { name: /^More actions for / }).click()
    await page.getByRole('menuitem', { name: 'Delete auto-sync' }).click()
    const conf = page.getByRole('alertdialog').or(page.getByRole('dialog').filter({ hasText: /delete|remove/i })).last()
    if (await visible(conf, 3000)) {
      const btn = conf.getByRole('button', { name: /Delete|Remove/ }).last()
      await btn.click()
    }
    // the removal waits behind an undo toast before it reaches the server
    const end = Date.now() + 20000
    while (Date.now() < end && (await watchesOf()).some((x) => x.id === st.watch.id)) await sleep(500)
    must(!(await watchesOf()).some((x) => x.id === st.watch.id), 'watch still there 20 s after deleting')
  })

  // ── rename tools ──
  await step('rename: name tester reads a name', async () => {
    await go(page, '/rules')
    const tester = page.getByRole('region', { name: 'Test a name' })
    must(await visible(tester), 'name tester missing on /rules')
    await tester.getByRole('textbox', { name: 'Test a name' }).fill('Lycoris Recoil S2 - 05 [GerJapDub,GerEngSub] [1080p].mkv')
    const reads = tester.getByRole('list', { name: 'What WeebSync reads' })
    must(await visible(reads.getByText(/Lycoris Recoil/)), 'title not read from the typed name')
    must(await visible(reads.getByText(/Season\s*2/)), 'season not read from the typed name')
  })

  await step('rename: preview and apply on a scratch folder', async () => {
    const files = (await localList('e2e-watch')).filter((e) => !e.isDir && /\.mkv$/.test(e.name))
    if (!files.length) skip('no downloaded episodes in e2e-watch to rename')
    await go(page, '/rename')
    await page.getByRole('region', { name: 'Folder selection' }).getByRole('button', { name: 'e2e-watch', exact: true }).click()
    const result = page.getByRole('region', { name: 'Result' })
    const rows = result.getByRole('row').filter({ has: page.getByRole('checkbox') })
    must(await visible(rows.nth(1)), 'no preview rows')
    const text = await result.innerText()
    must(/S\d\dE\d\d/.test(text), 'preview shows no SxxEyy name')
    await result.getByRole('button', { name: 'Apply' }).click()
    // apply may ask first
    if (await visible(page.locator('.ws-confirm-foot'), 2500)) await confirmYes(page)
    const end = Date.now() + 10000
    let renamed = []
    while (Date.now() < end) {
      renamed = (await localList('e2e-watch')).filter((e) => /S\d\dE\d\d/.test(e.name))
      if (renamed.length) break
      await sleep(400)
    }
    must(renamed.length > 0, 'nothing renamed on disk after Apply')
  })

  // ── rules, matching, match routing ──
  await step('rules: page loads', async () => {
    await go(page, '/rules')
    must(await visible(page.getByRole('heading', { name: 'How WeebSync decides', level: 1 })), 'no heading')
    must(await visible(page.getByRole('region', { name: 'Auto-sync' })), 'auto-sync rules missing')
    await noErrorState(page)
  })

  await step('matching: change crawl interval, save, reload', async () => {
    if (!st.server) skip('no server')
    await go(page, '/settings/matching')
    const field = () => page.getByRole('region', { name: SERVER_NAME }).getByLabel('Crawl every … minutes')
    must(await visible(field()), 'no crawl interval field')
    const old = await field().inputValue()
    await field().fill('7')
    await field().press('Tab')
    await saveIfAsked(page)
    await go(page, '/settings/matching')
    const now = await field().inputValue()
    must(now === '7', `reload shows ${now}`)
    await field().fill(old)
    await field().press('Tab')
    await saveIfAsked(page)
  })

  await step('match routing: toggle a provider, reload', async () => {
    await go(page, '/settings/matching')
    const sw = () => page.getByRole('region', { name: 'Anime series' }).getByRole('switch', { name: 'Use TMDB for Anime series' })
    must(await visible(sw()), 'no routing switch')
    const was = await sw().isChecked()
    await sw().click()
    await saveIfAsked(page)
    await sleep(800)
    await go(page, '/settings/matching')
    const now = await sw().isChecked()
    must(now !== was, `switch is ${now} after reload, was ${was}`)
    await sw().click()
    await saveIfAsked(page)
    await sleep(500)
  })

  // ── settings pages ──
  await step('settings: general (animations switch persists)', async () => {
    await go(page, '/settings/general')
    const sw = () => page.getByRole('switch', { name: 'Animations' })
    must(await visible(sw()), 'no animations switch')
    const was = await sw().isChecked()
    await sw().click()
    await saveIfAsked(page)
    await sleep(800)
    await go(page, '/settings/general')
    const now = await sw().isChecked()
    must(now !== was, `animations ${now} after reload, was ${was}`)
    await sw().click()
    await saveIfAsked(page)
    await sleep(500)
  })

  await step('settings: sync defaults (check interval)', async () => {
    await go(page, '/settings/sync')
    const f = () => page.getByLabel('Auto-sync checks every … minutes')
    must(await visible(f()), 'no interval field')
    const old = await f().inputValue()
    await f().fill('45')
    await saveIfAsked(page)
    await go(page, '/settings/sync')
    must((await f().inputValue()) === '45', `reload shows ${await f().inputValue()}`)
    await f().fill(old)
    await saveIfAsked(page)
  })

  await step('settings: notifications prefs save', async () => {
    await go(page, '/settings/notifications')
    const sw = () => page.getByRole('switch', { name: 'Suggestions by push' })
    must(await visible(sw()), 'no "Suggestions by push" switch')
    const was = await sw().isChecked()
    await sw().click()
    await saveIfAsked(page)
    await sleep(800)
    await go(page, '/settings/notifications')
    const now = await sw().isChecked()
    must(now !== was, `switch ${now} after reload, was ${was}`)
    await sw().click()
    await saveIfAsked(page)
    await sleep(500)
  })

  await step('settings: playback loads, hardware test runs', async () => {
    await go(page, '/settings/playback')
    must(await visible(page.getByRole('heading', { name: 'Playback', level: 2 })), 'no heading')
    const retest = page.getByRole('button', { name: 'Test again' })
    if (await visible(retest, 3000)) {
      await retest.click()
      await sleep(2500)
    }
    await noErrorState(page)
  })

  await step('settings: downloads rate limit', async () => {
    await go(page, '/settings/downloads')
    const f = () => page.getByLabel('Total limit in KiB/s')
    must(await visible(f()), 'no rate limit field')
    await f().fill('512')
    await f().press('Tab')
    await saveIfAsked(page)
    await sleep(800)
    await go(page, '/settings/downloads')
    must((await f().inputValue()) === '512', `reload shows ${await f().inputValue()}`)
    await f().fill('0')
    await f().press('Tab')
    await saveIfAsked(page)
    await sleep(500)
  })

  await step('settings: data (TTL edit)', async () => {
    await go(page, '/settings/data')
    const f = () => page.getByLabel('TTL (h)').first()
    must(await visible(f()), 'no TTL field')
    const old = await f().inputValue()
    await f().fill('30')
    await f().press('Tab')
    await saveIfAsked(page)
    await sleep(800)
    await go(page, '/settings/data')
    must((await f().inputValue()) === '30', `reload shows ${await f().inputValue()}`)
    await f().fill(old)
    await f().press('Tab')
    await saveIfAsked(page)
    await sleep(500)
  })

  await step('settings: security API token create/regenerate/revoke', async () => {
    await go(page, '/settings/security')
    const panel = page.getByRole('region', { name: /^API token/ })
    // a token from an earlier run goes first
    if (await visible(panel.getByRole('button', { name: 'Revoke' }), 2000)) {
      await panel.getByRole('button', { name: 'Revoke' }).click()
      if (await visible(page.locator('.ws-confirm-foot'), 2000)) await confirmYes(page)
      await sleep(500)
    }
    await panel.getByRole('button', { name: 'Generate' }).click()
    const field = () => panel.getByRole('textbox', { name: /^Token/ })
    must(await visible(field()), 'no token shown after Generate')
    const t1 = await field().inputValue()
    must((await bearer(t1)) === 200, 'new token does not open /api/status')
    await panel.getByRole('button', { name: 'Regenerate' }).click()
    // whether it asks is a step of its own, below
    st.regenAsked = await visible(page.locator('.ws-confirm-foot'), 3000)
    if (st.regenAsked) await confirmYes(page)
    await sleep(800)
    const t2 = await field().inputValue()
    must(t2 && t2 !== t1, 'token did not change on Regenerate')
    must((await bearer(t1)) === 401, 'old token still works after Regenerate')
    must((await bearer(t2)) === 200, 'regenerated token does not work')
    await panel.getByRole('button', { name: 'Revoke' }).click()
    if (await visible(page.locator('.ws-confirm-foot'), 2000)) await confirmYes(page)
    await sleep(800)
    must((await bearer(t2)) === 401, 'revoked token still works')
  })

  await step('settings: security API token regenerate asks first', async () => {
    if (st.regenAsked === undefined) skip('the token step did not get that far')
    must(st.regenAsked, 'Regenerate replaced a working token without asking')
  })

  await step('integrations: connect Jellyfin, libraries listed', async () => {
    if (!JELLYFIN.url || !JELLYFIN.key) skip('WS_JELLYFIN_URL / WS_JELLYFIN_KEY not set')
    let libs = []
    try {
      const r = await fetch(`${JELLYFIN.url}/Library/VirtualFolders`, {
        headers: { Authorization: `MediaBrowser Token="${JELLYFIN.key}"` },
      })
      libs = (await r.json()).map((l) => l.Name)
    } catch {
      skip('Jellyfin test server not reachable')
    }
    await go(page, '/settings/integrations')
    const jf = () => page.getByRole('region', { name: 'Jellyfin' })
    await jf().getByLabel('Jellyfin URL').fill(JELLYFIN.url)
    const key = jf().getByLabel('Jellyfin API key')
    if (!(await key.isVisible().catch(() => false))) await jf().getByText('Connect with an API key').click()
    await key.fill(JELLYFIN.key)
    await saveIfAsked(page)
    await sleep(1500)
    await go(page, '/settings/integrations')
    must(!(await jf().getByText('No Jellyfin server connected yet').isVisible().catch(() => false)), 'still "not connected" after saving')
    if (!libs.length) return 'connected; the test server has no libraries'
    must(await visible(jf().getByText(libs[0], { exact: false }), 15000), `library "${libs[0]}" not shown`)
  })

  // ── users ──
  await step('users: create, approve, sign in as a non-admin, limits, delete', async () => {
    await go(page, '/settings/security')
    const usersP = () => page.getByRole('region', { name: 'Users' })
    const row = () => usersP().getByRole('listitem').filter({ hasText: USER2.email })
    // an account from an earlier run goes first
    const stale = row().getByRole('button', { name: /^Delete/ })
    if (await visible(stale, 1500)) {
      await stale.click()
      await confirmYes(page)
      await sleep(800)
    }
    await usersP().getByLabel('Email', { exact: true }).fill(USER2.email)
    await usersP().getByLabel('Password', { exact: true }).fill(USER2.password)
    await usersP().getByRole('button', { name: 'Create' }).click()
    must(await visible(usersP().getByText(USER2.email)), 'new user not listed')
    const approve = row().getByRole('button', { name: /^Approve/ })
    if (await visible(approve, 2000)) await approve.click()
    await sleep(500)
    // the second user, in a context of their own
    const ctx2 = await newCtx()
    const p2 = await ctx2.newPage()
    p2.setDefaultTimeout(10000)
    p2.setDefaultNavigationTimeout(30000)
    observe(p2, watch)
    try {
      await loginForm(p2, USER2.email, USER2.password)
      must(await signedIn(p2), 'second user could not sign in')
      // the UI offers no rename or delete on the local library
      await go(p2, `/files?source=local&path=${DL_DIR}`)
      const anyFile = p2.locator('.ws-cl-row').first()
      if (await visible(anyFile, 4000)) {
        await anyFile.click()
        must(!(await visible(p2.getByRole('button', { name: /^Rename / }), 1500)), 'rename offered to a non-admin')
        must(!(await visible(p2.getByRole('button', { name: /^Delete / }), 500)), 'delete offered to a non-admin')
      }
      // and the API refuses it
      const target = (await localList(DL_DIR)).find((e) => !e.isDir)
      if (target) {
        const rn = await api(p2, 'POST', '/api/browse/local/rename', { path: target.path, name: 'x-' + target.name })
        must(rn.status === 403, `non-admin rename answered ${rn.status}`)
        const del = await api(p2, 'DELETE', '/api/browse/local', { path: target.path, recursive: false })
        must(del.status === 403, `non-admin delete answered ${del.status}`)
      }
      const mk = await api(p2, 'POST', '/api/browse/local/mkdir', { path: `/${DL_DIR}/by-takina` })
      must(mk.status < 300, `non-admin mkdir answered ${mk.status}`)
    } finally {
      await ctx2.close()
    }
    await go(page, '/settings/security')
    await row().getByRole('button', { name: /^Delete/ }).click()
    must(await visible(page.locator('.ws-confirm-foot')), 'delete did not ask first')
    await confirmYes(page)
    await sleep(800)
    await go(page, '/settings/security')
    must(!(await visible(usersP().getByText(USER2.email), 2000)), 'user still listed after deleting')
  })

  // ── views ──
  for (const route of [
    '/',
    '/needs',
    '/history',
    '/calendar',
    '/watches',
    '/watches?view=calendar',
    '/discover/merkliste',
    '/discover/empfohlen',
    '/discover/trending',
    '/discover/upgrades',
    '/discover/unvollstaendig',
    '/discover/duplikate',
    '/discover/ausgeblendet',
    '/settings/jobs',
    '/settings/about',
    '/settings/servers',
  ]) {
    await step(`view: ${route} loads`, async () => {
      await go(page, route)
      await sleep(1200)
      must(await visible(page.locator('main h1, main h2, [role=dialog] h1').first()), 'no heading rendered')
      await noErrorState(page)
    })
  }

  await step('player: local media file', async () => {
    let dir = DL_DIR
    let f = (await localList(dir)).find((e) => !e.isDir && /\.(mkv|mp4)$/.test(e.name))
    if (!f) {
      dir = 'e2e-watch'
      f = (await localList(dir)).find((e) => !e.isDir && /\.(mkv|mp4)$/.test(e.name))
    }
    if (!f) skip('no local media file')
    // the test files are sparse dummies: probing them fails upstream (502),
    // which is the answer the page has to cope with here
    watch.allow5xx.push(/\/api\/play\//)
    await go(page, `/files?source=local&path=${dir}`)
    await page.getByRole('button', { name: `Play ${f.name}`, exact: true }).click()
    await page.waitForURL(/\/play\?/, { timeout: 8000 })
    await sleep(3000)
    // a sparse dummy cannot play: the page shows a player or an error state,
    // but no page error (those fail the step on their own)
    must(await visible(page.locator('video, [role=alert], .text-err').filter({ visible: true }).first()), 'player shows neither a video nor an error')
  })

  await step('viewer: route renders for a local file', async () => {
    const f = [...(await localList(DL_DIR)), ...(await localList('e2e-watch'))].find((e) => !e.isDir && !e.name.endsWith('.part'))
    if (!f) skip('no local file')
    await go(page, `/view?server=0&path=${encodeURIComponent(f.path)}`)
    await sleep(2000)
    // a video is not the viewer's to show: it says so, or shows the file
    must(await visible(page.locator('main').filter({ visible: true }).first()), 'viewer rendered nothing')
    must(((await page.locator('main').filter({ visible: true }).first().innerText()) || '').trim(), 'viewer main is empty')
  })

  await step('command palette: opens with Ctrl+K, search navigates', async () => {
    await go(page, '/')
    await page.keyboard.press('Control+k')
    const dlg = page.getByRole('dialog', { name: 'Search' })
    must(await visible(dlg), 'palette did not open')
    await dlg.getByRole('combobox', { name: 'Search' }).fill('Download defaults')
    const opt = dlg.getByRole('option').filter({ hasText: 'Download defaults' }).first()
    must(await visible(opt), 'no result for "Download defaults"')
    await opt.click()
    await page.waitForURL(/\/settings\/sync/, { timeout: 8000 })
  })

  await browser.close()
}

// A folder on the server with at least three small video files, breadth
// first from the root, so the run downloads megabytes and not gigabytes.
async function findEpisodes(page, id) {
  const queue = ['/data']
  let listed = 0
  while (queue.length && listed < 120) {
    const dir = queue.shift()
    const r = await api(page, 'GET', `/api/servers/${id}/browse?path=${encodeURIComponent(dir)}`)
    listed++
    if (!Array.isArray(r.data)) continue
    const files = r.data.filter((e) => !e.isDir && /\.(mkv|mp4)$/i.test(e.name) && e.size > 0 && e.size <= 8 << 20)
    if (files.length >= 3) return { path: dir, files: files.slice(0, 3) }
    for (const e of r.data) if (e.isDir) queue.push(e.path)
  }
  return null
}

// the confirm dialog's own button (the right one of the two)
async function confirmYes(page) {
  await page.locator('.ws-confirm-foot button').last().click()
}

// settings pages with a save bar save there; the rest save at once
async function saveIfAsked(page) {
  await sleep(300)
  const bar = page.getByRole('region', { name: 'Save' })
  const btn = bar.getByRole('button', { name: 'Save', exact: true })
  if (await btn.isVisible().catch(() => false)) {
    await btn.click()
    await bar.getByText('Saved').waitFor({ timeout: 6000 }).catch(() => {})
  }
  await sleep(300)
}

// what a route shows when it fell over
async function noErrorState(page) {
  const crash = page.getByText(/This view could not be loaded|Something went wrong/)
  if (await crash.first().isVisible().catch(() => false)) throw new Error('route error screen shown')
}

// the machine API, as Home Assistant calls it
async function bearer(token) {
  const r = await fetch(`${BASE}/api/status`, { headers: { Authorization: `Bearer ${token}` } })
  return r.status
}


mkdirSync(OUT, { recursive: true })
if (!EMAIL || !PASSWORD) {
  console.error('Set WS_EMAIL and WS_PASSWORD (the admin account; the setup wizard creates it on a fresh instance).')
  process.exit(2)
}
for (const engine of BROWSERS) {
  console.log(`\n== ${engine} ${BASE}`)
  const before = results.length
  await run(engine)
  for (const r of results.slice(before)) r.engine = engine
}
const file = `${OUT}/features-${TAG}.json`
writeFileSync(file, JSON.stringify(results, null, 1))
const count = (s) => results.filter((r) => r.status === s).length
console.log(`\n${count('PASS')} pass, ${count('FAIL')} fail, ${count('SKIP')} skip -> ${file}`)
process.exit(count('FAIL') ? 1 : 0)
