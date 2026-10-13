# Fluid Lycoris

A design system for media apps: Material 3 Expressive motion with a two-colour
code taken from Lycoris Recoil. Red (the Lycoris half) and teal (the Recoil
half) each mean one thing, the rest of the palette stays quiet, and every
movement runs on a spring that comes to rest cleanly.

The package holds three things:

- `src/fluid-lycoris.css`: the theme tokens (dark and light), the control
  metrics and the styles of every `t-*` primitive. Plain CSS.
- `src/tailwind.css`: a Tailwind v4 bridge that maps utilities such as
  `text-t-muted`, `bg-bg-card` and `rounded-md` onto the tokens and points
  Tailwind's content scan at the package.
- `src/index.ts`: presentational React components and hooks. Props only: no
  data fetching, no router, no i18n, no app names. Every text arrives as a prop.

## Using it in a project

```css
/* the host loads the fonts: Chakra Petch (500-700), IBM Plex Sans (400-600),
   IBM Plex Mono (400-500), e.g. from @fontsource */
@import "tailwindcss";
@import "fluid-lycoris/fluid-lycoris.css";
@import "fluid-lycoris/tailwind.css";
/* the host's own rules come after, so they win at equal specificity */
```

```tsx
import { Button, Dialog, Segmented } from 'fluid-lycoris'
```

React 18 or newer is a peer dependency. Contracts the stylesheet relies on:

| On `<html>` | Meaning |
|---|---|
| `data-theme="dark"` / `"light"` | the theme; without the attribute dark is the default and the OS light preference is followed |
| `data-scheme="recoil"` | swap the two halves of the colour code (see below); absent means Lycoris |
| `data-motion="off"` | an in-app "reduce motion" switch, on top of `prefers-reduced-motion` |
| class `kbd` | set once keyboard navigation starts; focus rings only show then |

Inside this repository the app resolves `fluid-lycoris` to `src/` through an
alias (vite, vitest and tsconfig), so there is no build step. `./build.sh`
produces `dist/` (an ES bundle with types) and copies the app's compiled
stylesheet to `styles.css` for the gallery in `index.html`.

## Tokens

### Colour

| Token | Dark (OLED) | Light | Use |
|---|---|---|---|
| `--bg` | `#000000` | `#fdf8f8` | the page |
| `--bg-2` | `#05070d` | `#ffffff` | bars, sheets, fields |
| `--card` | `#0b1120` | `#ffffff` | cards, dialogs |
| `--hover` | `#131b2e` | `#fbe9ec` | hover and selected ground |
| `--line` | `#1f2a40` | `#ecd3d8` | decorative hairlines |
| `--line-strong` | `#6b819c` | `#8a6f76` | edges that must be seen (3:1) |
| `--fg` / `--fg-2` / `--fg-3` | `#eef2f7` / `#bccadb` / `#8ea2b9` | `#1b2238` / `#3a4462` / `#5a6380` | text, three steps |
| `--accent` / `--on-accent` | `#ef6177` / `#1a0509` | `#b3263f` / `#ffffff` | red |
| `--accent-2` / `--on-accent-2` | `#33c2b5` / `#03201d` | `#0c7069` / `#ffffff` | teal |
| `--tint-1` / `--tint-2` | red / teal mixed into black | `#fcecf5` / `#e9faf8` | quiet grounds, ribbons |
| `--ok` / `--warn` / `--err` | `#5fd38d` / `#f2c46b` / `#ff9a5c` | `#1d6b3d` / `#7d5200` / `#a8440a` | states |
| `--fl-ink` / `--fl-cream` | `#000000` / `#f4ead6` | `#1b2238` / `#f4ead6` | art: ink lines, cream fills |
| `--scrim` | black 66% | navy 32% | behind sheets |

Every text colour clears 4.5:1 on `--bg`, `--bg-2`, `--card` and `--hover` of
its theme. `--err` leans orange because the accent is already red, so an error
always carries an icon and a word as well.

### Colour code

- **Red (`--accent`)**: live, new, the main action, the "today" and "discover"
  areas, the slanted marker of a section heading.
- **Teal (`--accent-2`)**: sync, matching, rules, "why?" explanations, airing
  times, the sync and files areas of the navigation, their section markers.

The **Recoil** scheme (`data-scheme="recoil"`) swaps the two values: the main
action turns teal and sync turns red. The pairing stays intact, which is why
the package offers this switch instead of free accent colours.

A host stores the choice and sets `data-scheme`; a `[data-scheme]` on any
element (a settings preview) paints that subtree in the named scheme.

### Shape and type

- Radii: `--r-xs` 4, `--r-chip` 4, `--r-ctl-sm` 8, `--r-ctl` 8, `--r-item` 7,
  `--r-menu` 10, `--r-panel` 12, `--r-dialog` 14, `--r-cover` 6, `--r-sheet` 20. Nested boxes follow the concentric rule: inner radius =
  outer radius minus the padding between them, never below `--r-xs`.
- Covers are rounded and carry no ring, border or inset shadow.
- Control metrics: `--ctl-h` 44px, `--ctl-h-sm` 34px (in rem), `--ctl-fs*`,
  `--ctl-lh*`; touch (`pointer: coarse`) adjusts them. A new control takes its height and radius
  from these variables, never from padding plus inherited text.
- Fonts: `--f-display` (Chakra Petch), `--f-sans` (IBM Plex Sans), `--f-mono`
  (IBM Plex Mono). Type scale: `--fs-tab`, `--fs-caption`, `--fs-meta`,
  `--fs-link`, `--fs-body`, `--fs-section`, `--fs-sheet`, `--fs-title`,
  `--fs-title-lg`, `--fs-big`. Sentence case everywhere; nothing is
  uppercased or tracked except a brand mark.

## Motion

- Springs: `--m3-spatial` (Material 3 Expressive fast spatial spring) and
  `--spring` carry one small overshoot and are for things that move or grow:
  a press, a morph. `--spring-calm` has none and is for sheets, toasts,
  thumbs and small parts. Colour and opacity never ride a spring.
- Durations `--dur-1` 120ms (hover, tick), `--dur-2` 200ms (panel, toast,
  every exit), `--dur-3` 280ms (dialog, sheet); `--d-1..3` are aliases.
  Enter eases out, exit eases in and is shorter.
- A clickable cover zooms its art to 1.06 inside its frame on hover and sinks
  the frame to 0.97 on press. Animated layers keep `will-change` so an
  animation never ends in a raster jolt.
- Nothing loops. An animation plays once on entry or on an event and comes to
  rest.
- `prefers-reduced-motion` and `data-motion="off"` cut every animation and
  transition to an instant change; state still changes.
- View transitions are progressive: without `document.startViewTransition`
  the state changes without the animation.

## Components

Besides the controls (`Button` with `primary`, `danger`, `danger-fill`;
`IconButton` 44 or 36 round; `Input`; `Checkbox`; `Radio`; `Badge`), the
package has:

- `SectionHeading`: a sentence-case h2 after a slanted marker (red, or teal
  with `tone="accent-2"`) and an optional `TextLink` at the right.
- `Rows`, `Row`, `RowAction`: hairline lists, no panel around them.
- `TextLink`, `Kbd`, `EmptyState` (a quiet line, or `inline` as a list item).
- `Segmented` (gliding thumb), `Switch` (a checkbox with the switch role),
  `SettingsField` (label, chip, control, hint).
- `Select`: the select-only combobox pattern. No native popup: a glass
  listbox in the top layer, the picked option in the accent with a check,
  arrows, Home, End, Page keys, Enter, Escape and type-ahead. It takes
  `<option>` children and a native-style change handler, and submits through
  a hidden field.
- `Cover` (rounded, no ring, hover zoom and press sink inside a button or
  link, a title fallback), `Art` (a banner as one layer with its dot screen,
  5px past its frame, optionally duotone), `CoverStatus`, `CoverScore`,
  `CoverBar`.
- `Rail`: a horizontal shelf with edge fades, paging buttons on hover devices
  and mouse drag.
- `Wipe` and `useWipe`: show or hide a line of text with the credits wipe.
  `enterPage` / `useEnterPage`: on entering a page or switching its content,
  titles and section headings wipe in, meters fill, and rows, shelf items and
  `[data-rise]` children rise in one wave from left to right.
- `Toast` and `ToastRegion`: inverted toasts in the top layer, left of an
  open `SidePanel`.
- `Dialog`, `Modal`, `SidePanel`, `Menu`, `Tabs` and the rest of the
  composites.

Native controls never show their browser look: checkboxes, radios, ranges and
search fields are drawn by the theme, scrollbars are thin and in the theme's
colours.
