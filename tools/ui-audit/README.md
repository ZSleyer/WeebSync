# UI audit

Playwright passes over a running instance, in Chromium and Firefox, at
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
  and that a phone-sized sheet sits on the bottom edge, leaves a strip of the
  page visible to tap, and offers exactly one close button.
- `sheet.mjs` drives the phone sheet's gestures with **real touch**, through
  CDP rather than Playwright's mouse. It is separate because the other two
  cannot see this class of bug at all: they measure a sheet standing still, and
  a mouse drag is not governed by `touch-action`, so a sheet no thumb could
  move once passed every check on both engines while the phone did nothing.
  Nine rules per viewport - a short pull follows and springs back while the
  backdrop dims with it, a long one dismisses, a pull up follows the finger
  and opens the sheet to its full height on release, a pull down from there
  gives the opening height back, the next one dismisses, one long pull from
  the full height closes in one go, a pull inside scrolled content scrolls
  the content instead, and two quick swipes on the calendar deck turn two
  pages. Every
  release is watched frame by frame: the sheet's top edge and the deck's
  position are sampled on each animation frame and the largest step between
  two frames is the finding - a detent that snaps while the transform still
  holds the pull is a one-frame jump that two snapshots 600ms apart never see,
  and it is exactly what a phone recording shows as "the sheet jumps". Chromium only:
  Playwright's Firefox driver dispatches neither touch nor pointer events for
  synthetic input, so there is nothing to drive there.

- `overlap.mjs` is shared by `e2e.mjs` and `modals.mjs`: it scrolls a page
  or dialog through and reports text drawn over other text (or a form
  control), text hanging out of its box, and text cut off by
  `overflow: hidden` without an ellipsis. The case it was written for: a
  field with `height: 100%` in a stretched grid item, whose hints ran over
  the next field's label.
- `contrast.mjs` measures WCAG 2.2 AA contrast against what is actually
  painted behind each thing (glass, opacity and text on cover art included,
  the latter sampled from a screenshot), in the dark and the light theme:
  text and placeholders, control boundaries and icon buttons (1.4.11) and
  the focus indicator of the first 25 Tab stops. `--inject '<css>'` adds a
  known failure, to check that a clean run is not a blind one.

`--viewports phone,wide` (448x998 and 1440x900) and `--browsers chromium`
narrow `e2e.mjs` and `modals.mjs` to a subset.

`auth.mjs` is how every pass gets in: `WS_TOKEN` (the raw token whose SHA-256
sits in the `sessions` table, the way in when the instance is OIDC-only) wins,
otherwise a password login with `WS_EMAIL` and `WS_PASSWORD`. There are no
default credentials; a pass started without either stops before it opens a
browser, and one whose login is refused stops too, rather than auditing the
login screen and calling it clean.

A chip that is prose rather than a chip - a page subtitle, a status line
carrying a user name - opts out of the wrap check with `<Badge multiline>`.

All passes need `playwright` and a logged-in session. The version is pinned exactly in
`package.json` and locked in `yarn.lock`, because each release expects browser
builds of its own - 1.62.0 wants chromium-1234 and firefox-1538. Install both
here once:

    cd tools/ui-audit && yarn install && npx playwright install chromium firefox

Then run the passes from the repo root:

    export WS_EMAIL=<account e-mail> WS_PASSWORD=<account password>
    node tools/ui-audit/e2e.mjs --base http://127.0.0.1:8080
    node tools/ui-audit/modals.mjs --base http://127.0.0.1:8080
    node tools/ui-audit/sheet.mjs --base http://127.0.0.1:8080
    node tools/ui-audit/contrast.mjs --base http://127.0.0.1:8080

**Point `--base` at an instance that actually serves the frontend.** The backend
does not embed it; without `WEEBSYNC_WEB` pointing at a built `frontend/dist`
every route answers 404, and both passes then report a clean bill of health for
pages they never saw. `curl -o /dev/null -w '%{http_code}' <base>/` returning 200
is the check worth doing before believing a green run.

`modals.mjs` prints which trigger fired where and **fails on a trigger that
never fired anywhere** - a renamed button (the English label drifting away from
the German one) would otherwise make a whole dialog invisible and still report
a clean run. A few dialogs only exist where there is data behind them; their
triggers carry an `optional` note, are listed as skipped with what they need,
and do not fail the run. What a run needs to reach all of them:

- a backend started with the `WEEBSYNC_SECRET` its stored server credentials
  were encrypted with, otherwise every listing answers `decrypt failed` and the
  catalogue stays empty,
- at least one watch (the series page's action sheet),
- a local library with at least one folder (its catalogue dialogs),
- a reachable server with a folder that matched a title (the remote catalogue
  dialogs),
- a connected Plex server (the Plex series picker in the watch editor),
- a transfer in progress (the live activity's transfer sheet).

`--routes /a,/b` limits `e2e.mjs` to a subset, `--out` and `--tag` steer where
the screenshots land.

## On a real device

`device/` holds two standalone pages for the questions the emulators cannot
answer - neither Chrome's device toolbar nor Firefox's responsive mode has a
dynamic browser toolbar or safe-area insets, so both report `dvh == svh == lvh`
and zero insets, and a layout that only breaks on a phone passes here.

- `viewport-probe.html` prints `dvh`/`svh`/`lvh`, the visual viewport, the
  safe-area insets and whether the document scrolls, keeping the extremes seen
  over the whole session (a screenshot taken after the toolbar settled shows
  nothing).
- `viewport-lab.html?m=a|b|c` renders the same page in three shell layouts -
  inner scroller with `100dvh`, document scroller with a `fixed` bar, document
  scroller with a `sticky` bar - and reports how far the bottom bar drifted from
  the visible edge. It labels the browser itself, because reading the numbers by
  selecting them scrolls the page and changes what is measured.

To use them, copy the file into `frontend/public/`, start the dev server with
`--host`, open the port for the LAN, and call it from the phone. They are not in
`public/` by default: they would ship to production for nobody's benefit.
