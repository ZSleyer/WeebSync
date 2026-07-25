# UI audit

Two Playwright passes over a running instance, in Chromium and Firefox, at
desktop 1280x900 and Pixel 8 Pro 448x998 (DPR 3):

- `e2e.mjs` walks every route and checks WCAG 2.2 AA text contrast (1.4.3),
  target size (2.5.8), control heights within a row, stray scrollbars and
  console errors, and leaves one screenshot per route/browser/viewport behind.
- `modals.mjs` opens every dialog the app has and applies the same checks
  there, which a route pass cannot reach: a dialog is not in the DOM until
  something is clicked.

Both need `playwright` (1.61.0 matches the cached chromium-1228 and
firefox-1532 builds) and a logged-in session. Install it here once:

    cd tools/ui-audit && yarn install

Then run the passes from the repo root:

    WS_TOKEN=<raw session token> node tools/ui-audit/e2e.mjs --base http://127.0.0.1:8080
    WS_TOKEN=<raw session token> node tools/ui-audit/modals.mjs --base http://127.0.0.1:8080

`WS_TOKEN` is the raw token whose SHA-256 sits in the `sessions` table - the
way in when the instance is OIDC-only. Without it both fall back to a password
login. `--routes /a,/b` limits `e2e.mjs` to a subset, `--out` and `--tag` steer
where the screenshots land.
