# UI audit

Two Playwright passes over a running instance, in Chromium and Firefox, at
desktop 1280x900, Pixel 8 Pro 448x998 and iPhone 14 393x852 (both DPR 3). The
two phones are the real target devices; 393px is the narrower of them and the
one that finds labels which no longer fit on a single line.

- `e2e.mjs` walks every route and checks WCAG 2.2 AA text contrast (1.4.3),
  target size (2.5.8), control heights within a row, stray scrollbars, console
  errors, labels that had to wrap (with the width they would have needed), and
  whether the mobile header and tab bar stay pinned across a scroll. It leaves
  one screenshot per route/browser/viewport behind.
- `modals.mjs` opens every dialog the app has and applies the same checks
  there, which a route pass cannot reach: a dialog is not in the DOM until
  something is clicked. It also asserts the page behind a modal cannot scroll,
  and that a phone-sized sheet fills the screen and offers exactly one close
  button.

A chip that is prose rather than a chip - a page subtitle, a status line
carrying a user name - opts out of the wrap check with `<Badge multiline>`.

Both need `playwright` and a logged-in session. The version is pinned exactly in
`package.json` and locked in `yarn.lock`, because each release expects browser
builds of its own - 1.62.0 wants chromium-1234 and firefox-1538. Install both
here once:

    cd tools/ui-audit && yarn install && npx playwright install chromium firefox

Then run the passes from the repo root:

    WS_TOKEN=<raw session token> node tools/ui-audit/e2e.mjs --base http://127.0.0.1:8080
    WS_TOKEN=<raw session token> node tools/ui-audit/modals.mjs --base http://127.0.0.1:8080

**Point `--base` at an instance that actually serves the frontend.** The backend
does not embed it; without `WEEBSYNC_WEB` pointing at a built `frontend/dist`
every route answers 404, and both passes then report a clean bill of health for
pages they never saw. `curl -o /dev/null -w '%{http_code}' <base>/` returning 200
is the check worth doing before believing a green run.

Half of these dialogs only exist where there is data behind them, so `modals.mjs`
prints which trigger fired where and **fails on a trigger that never fired
anywhere** - a renamed button (the English label drifting away from the German
one) would otherwise make a whole dialog invisible and still report a clean run.
What the run needs to reach all of them:

- a backend started with the `WEEBSYNC_SECRET` its stored server credentials
  were encrypted with, otherwise every listing answers `decrypt failed` and the
  catalogue stays empty,
- a reachable server with a folder that matched a title (the catalogue dialogs),
- a watch whose local folder has a gap in its episode numbers, e.g. `S01E01`,
  `S01E02`, `S01E04` (the episode-list dialog behind the gap badge).

`WS_TOKEN` is the raw token whose SHA-256 sits in the `sessions` table - the
way in when the instance is OIDC-only. Without it both fall back to a password
login. `--routes /a,/b` limits `e2e.mjs` to a subset, `--out` and `--tag` steer
where the screenshots land.
