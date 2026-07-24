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

Why the fixed line box: `.t-input` and `.t-select` used to inherit their font
from the surrounding element while `.t-btn` carried its own, so the same three
controls came out 33px, 37px and 41.5px depending on where they sat. Any new
control class must take its height from these variables rather than from
padding plus inherited text.

`.t-toolbar` narrows both variables to `2rem` for its own row - that is the one
sanctioned exception, and it works by overriding the variables, not the rules.

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
