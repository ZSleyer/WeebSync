// The way into the instance under test, shared by every pass. A session token
// in WS_TOKEN (the raw value whose SHA-256 sits in the `sessions` table) wins,
// which is the only way in on an OIDC-only instance; otherwise a password
// login with WS_EMAIL and WS_PASSWORD. There are no defaults on purpose: a
// guessed account fails every request with 401 and a pass over login screens
// reports a clean run.
export const TOKEN = process.env.WS_TOKEN || ''
export const LOGIN = { email: process.env.WS_EMAIL || '', password: process.env.WS_PASSWORD || '' }

if (!TOKEN && !(LOGIN.email && LOGIN.password)) {
  console.error('Set WS_TOKEN, or WS_EMAIL and WS_PASSWORD, to log in to the instance under test.')
  process.exit(2)
}

/**
 * The session cookie for token at base, by the server's rules
 * (backend/internal/auth/session.go). Under HTTPS the session is
 * __Host-weebsync_session (Secure, Path=/, no Domain) and its token starts
 * with "h"; an unmarked token from before the prefix is still read under the
 * plain name there. Over plain HTTP the plain name holds it, and a token
 * starting with "h" is never taken. A token the instance would ignore stops
 * the pass instead of auditing the login screen.
 */
export function sessionCookie(token, base) {
  const url = new URL(base)
  const https = url.protocol === 'https:'
  if (https && token.startsWith('h')) {
    // url instead of domain/path: Path=/ on this host, Secure from the scheme
    return { name: '__Host-weebsync_session', value: token, url: url.origin + '/', httpOnly: true, sameSite: 'Lax' }
  }
  if (https && token.startsWith('p')) {
    throw new Error('WS_TOKEN starts with "p": a session made over plain HTTP, which an HTTPS instance does not take. Use one made over HTTPS (it starts with "h").')
  }
  if (!https && token.startsWith('h')) {
    throw new Error('WS_TOKEN starts with "h": a session made over HTTPS, which a plain-HTTP instance does not take. Use one made over HTTP (it starts with "p").')
  }
  return { name: 'weebsync_session', value: token, domain: url.hostname, path: '/', httpOnly: true, secure: https, sameSite: 'Lax' }
}

/** Signs the page's context in: the session cookie, or a password login. */
export async function signIn(ctx, page, base) {
  if (TOKEN) {
    let cookie
    try {
      cookie = sessionCookie(TOKEN, base)
    } catch (e) {
      console.error(e.message)
      process.exit(2)
    }
    await ctx.addCookies([cookie])
    return
  }
  if (!page.url().startsWith(base)) await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  const status = await page.evaluate(async (l) => {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(l),
    })
    return r.status
  }, LOGIN)
  if (status >= 400) {
    console.error(`Login as WS_EMAIL failed with HTTP ${status}.`)
    process.exit(2)
  }
}

/**
 * Launches an engine for an audit. Headless Chromium hides scrollbars by
 * default, which makes every desktop run measure a layout nobody sees: with a
 * classic 15px bar the content edge moves and a control flush with it is
 * suddenly under the bar. Keep them (touch contexts get overlay bars anyway).
 */
export const launch = (type) =>
  type.launch(type.name() === 'chromium' ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {})
