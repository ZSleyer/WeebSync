# WeebSync Tempest

WeebSync's copy of the Tempest design language, kept here so the app's controls
can be tuned without touching the Encounty repo it came from.

**This is a review gallery, not a component library.** There is no bundle and no
component API - the page pulls in the app's real stylesheet and renders every
control we reuse, so sizes and spacing can be measured instead of eyeballed.

## Token source of truth

`frontend/src/index.css`. The gallery imports the built stylesheet, so whatever
it shows is what the app renders. Nothing here is imported by the app.

## Control metrics

One height per family, fixed line boxes, all driven by variables in
`:root` (touch overrides them under `@media (pointer: coarse)`):

| Variable | Desktop | Touch | Used by |
|---|---|---|---|
| `--ctl-h` | 36px | 2.667rem (48px) | `.t-input`, `.t-select`, `.t-btn` |
| `--ctl-h-sm` | 26px | 2.222rem (40px) | `.t-btn--sm`, `.t-iconbtn`, `.t-divider` |
| `--ctl-fs` / `--ctl-lh` | 14 / 20px | 0.889 / 1.333rem | full-size controls |
| `--ctl-fs-sm` / `--ctl-lh-sm` | 11 / 16px | 0.722 / 1.111rem | small controls, `.t-label`, `.t-count` |
| `--nav-h` | 3.33rem | 3.33rem | `NavItem` bottom tabs, the shell's tab bar |

Composites that add no height of their own: `ActionBar` (a row of small
controls, the shell's `footer` row above the tab bar on a phone, sticky at
the bottom of the document on desktop), `Disclosure` (summary at
`--ctl-h-sm`), `Segmented` (small buttons). `AppBar` slots are `--ctl-h` tall
so a control in the bar meets the touch size.

Why the fixed line box: `.t-input` and `.t-select` used to inherit their font
from the surrounding element while `.t-btn` carried its own, so the same three
controls came out 33px, 37px and 41.5px depending on where they sat. Any new
control class must take its height from these variables rather than from
padding plus inherited text.

`.t-toolbar` narrows both variables to `2rem` for its own row - that is the one
sanctioned exception, and it works by overriding the variables, not the rules.

## Radii

One scale, tied to the control heights the same way. Every `t-*` class takes
its radius from these variables, and Tailwind's `rounded-xs` … `rounded-2xl`
are bridged onto the same steps (`@theme inline` in `index.css`), so a one-off
box in the app lands on the scale too. Bare `rounded` is not bridged - use a
step.

| Variable | Desktop | Touch | Utility | Used by |
|---|---|---|---|---|
| `--r-xs` | 4px | 4px | `rounded-xs` | a cover inside a padded panel (concentric floor) |
| `--r-chip` | 4px | 4px | `rounded-sm` | `.t-label`, checkbox |
| `--r-ctl-sm` | 4px | 6px | - | `.t-btn--sm`, `.t-iconbtn`, `--sm` inputs, toolbar chips |
| `--r-ctl` | 6px | 8px | `rounded-md` | `.t-btn`, `.t-input`, `.t-select`, `.t-tabs`, notes, tooltips |
| `--r-menu` | 8px | 8px | `rounded-lg` | `Menu`, dropdown lists, sub-boxes, chat bubbles, floating `ActionBar` |
| `--r-panel` | 10px | 10px | `rounded-xl` | `.t-panel`, composer, `FileBrowser` |
| `--r-dialog` | 12px | 12px | `rounded-2xl` | `<dialog>`; the phone sheet is 0 |
| full | - | - | `rounded-full` | dots, avatars, progress bars, the sheet's close button |

Nested boxes follow the concentric rule: inner radius = outer radius minus the
padding between them, never below `--r-xs`. A `Cover` in a `p-3` panel is
`10 − 12 → 4`, in a `p-2` entry `10 − 8 → 4`; a flush cover in a catalog tile
has no radius of its own and is clipped by the tile (`overflow-clip`).

A new control class takes its radius from `--r-*` the way it takes its height
from `--ctl-*`. `.t-toolbar` steps its controls down to `--r-ctl-sm` on touch,
where its boxes are the small height.

## Layout conventions

- Two-column form rows: one shared grid (`ROW_GRID` in `RenameOptions.tsx`), so
  the column edge never shifts between sections of the same dialog.
- Caption above a control: `.t-field` (flex column, `gap: 4px`, control pinned
  to the bottom) - never padding on the control itself, that would override its
  own and shrink it below its neighbour.
- A control next to a button: `items-stretch`, so the button takes the field's
  height instead of floating at its own.
- Icons: `size="1em"` so they ride the text size of their container.

## Regenerating

Open `index.html` directly (it references `../frontend/dist/assets/index-*.css`
via `build.sh`, which copies the current build in). Run `./build.sh` after a
frontend build to refresh the stylesheet copy.
