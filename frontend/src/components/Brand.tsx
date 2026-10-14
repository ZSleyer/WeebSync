import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LOGO_H, LOGO_W } from '../logo'
import Logo, { DURATION, INTROS, still, type Intro } from './Logo'

// The brand as one lockup that is either the mark or the wordmark, never both
// at rest. WS is WEEBSYNC cut short - W for WEEB, S for SYNC, in the same
// colours - so the move between them says exactly that: the mark's two
// letters fly to their places in the wordmark and turn into type there, the
// rest unfolds out of them; backwards it all folds into them again.
//
// - `rail` (the desktop sidebar): the wordmark rests; every page change folds
//   it into the mark, holds a beat and unfolds it again.
// - `hero` (login, setup): the large mark plays one of its intros, then
//   unfolds into the wordmark, once.
// - `about`: the wordmark, still.
//
// Each run picks one of two moves at random: unfold (the letters glide out
// of W and S) or roll (they roll up one by one, like the app's numbers). The
// slogan sits under SYNC like a subtitle or over it like furigana, drawn per
// mount, and never covers the mark. Motion runs on WAAPI with transform and
// opacity only; motion off shows each place's rest at once.

type Move = 'unfold' | 'roll'
const MOVES: Move[] = ['unfold', 'roll']
type Slogan = 'sub' | 'ruby'
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'
const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)'
// The mark is the wordmark's own W and S: the same Chakra Petch 700 glyphs,
// the S set 9° oblique and shifted left over the W, whose upper right arm the
// S cuts away, and the S's lower left end cut short in turn. Measured against
// the traced mark (public/favicon.svg) by overlaying both, so the move between
// mark and wordmark is the two letters taking that pose and leaving it - no
// swap between artwork and type anywhere in it.
// Glyph metrics in em: cap height, ascent and descent of the font's line box,
// and where the ink of W and S starts after the glyph origin.
const CAP = 0.705
const ASC = 0.9917
const DESC = 0.3078
const INK_W = 0.025
const INK_S = 0.05
// the S's origin in the mark's units (LOGO_W x LOGO_H), and its slant
const S_AT = 492.6
const S_SKEW = -9
// the part of the W the mark keeps, in the mark's units: everything but the
// upper right arm, cut along the S's left edge. Opening, the arm grows back
// out of its stub: the cut edge (points 4-6) travels up the arm's own
// direction - 0.19 across per unit up, measured on the glyph - keeping its
// angle, while the segment before it stays on the arm's inner edge
const W_CUT = [
  [-50, -50],
  [384, -50],
  [512, 419],
  [517, 417],
  [541, 275],
  [628, 366],
  [760, 366],
  [760, 650],
  [-50, 650],
]
const ARM = 0.19
const GROW = 430
const W_OPEN = W_CUT.map(([x, y], i) => (i >= 4 && i <= 6 ? [x + ARM * GROW, y - GROW] : [x, y]))
// The S's lower left end in the mark is cut too, on a line parallel to the
// W's right leg (public/favicon.svg: 653,496 to 633,594), so a gap stays
// between them; the glyph's own end ran on into the W. Only below the S's
// middle bar, the rest of its left side is untouched. Opening, the cut slides
// off to the left along the same line.
const S_CUT = [
  [-50, -50],
  [1100, -50],
  [1100, 700],
  [611.4, 700],
  [682.8, 350],
  [-50, 350],
]
const S_OPEN = S_CUT.map(([x, y], i) => (i === 3 || i === 4 ? [x - 400, y] : [x, y]))
const SLANT = Math.tan((S_SKEW * Math.PI) / 180)
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default function Brand({
  variant,
  slogan,
  replayKey,
  className = '',
}: {
  variant: 'rail' | 'hero' | 'about'
  /** the line under or over SYNC; omitted, the lockup has none */
  slogan?: string
  /** rail: a new value folds and unfolds the wordmark */
  replayKey?: string
  className?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const [kind] = useState<Slogan>(() => pick(['sub', 'ruby'] as const))
  const [intro] = useState<Intro>(() => pick(INTROS))
  // the hero's intro plays on the full Logo; W and S take over to unfold
  const [heroMark, setHeroMark] = useState(variant === 'hero')
  // the key the last run was for: the same key again is a remount (or React's
  // strict double run), not a page change
  const lastKey = useRef<string | undefined | null>(null)
  // a fold-and-unfold under way, and whether the lockup is still mounted
  const running = useRef(false)
  const gone = useRef(false)
  useEffect(
    () => () => {
      gone.current = true
    },
    [],
  )

  useLayoutEffect(() => {
    const el = root.current
    if (!el || variant === 'about') return
    const q = <T extends Element>(s: string) => [...el.querySelectorAll<T>(s)]
    const letters = q<HTMLElement>('[data-ch]')
    const word = el.querySelector<HTMLElement>('[data-word]')!
    // the mark's place and size; never seen, only measured
    const anchor = el.querySelector<SVGSVGElement>('[data-anchor]')!
    const tag = el.querySelector<HTMLElement>('[data-slogan]')
    const all = [word, ...letters, ...(tag ? [tag] : [])]
    const [lw, ls] = [letters[0], letters[4]]
    // the lockup left the page; a page change alone never cuts a run short
    const alive = () => !gone.current
    const stop = () => all.forEach((n) => n.getAnimations?.().forEach((a) => a.cancel()))
    const run = (n: Element, k: Keyframe[], o: KeyframeAnimationOptions & { duration: number }) =>
      n.animate(k, { fill: 'both', ...o }).finished.catch(() => {})

    // The pose of W or S in the mark, as a transform from the letter at rest
    // plus (for the W) the cut. Measured with the letter's own pose cleared.
    const pose = (letter: HTMLElement, s: boolean) => {
      letter.style.transform = ''
      letter.style.clipPath = ''
      const mb = anchor.getBoundingClientRect()
      const lb = letter.getBoundingClientRect()
      const cs = getComputedStyle(letter)
      const fs = parseFloat(cs.fontSize)
      const lh = cs.lineHeight === 'normal' ? (ASC + DESC) * fs : parseFloat(cs.lineHeight)
      // the cap's top and the baseline inside the letter's box
      const capTop = (lh - (ASC + DESC) * fs) / 2 + (ASC - CAP) * fs
      const ox = (s ? INK_S : INK_W) * fs
      const oy = s ? capTop + CAP * fs : capTop
      const k = mb.height / (CAP * fs)
      const unit = mb.height / LOGO_H
      // W: its ink's top left onto the mark's top left; S: its origin on the
      // baseline onto its place on the mark's foot, then the slant
      const tx = (s ? mb.left + S_AT * unit : mb.left) - (lb.left + ox)
      const ty = (s ? mb.bottom : mb.top) - (lb.top + oy)
      const u = (CAP * fs) / LOGO_H
      // mark units into the letter's own box: the W's ink top left is the
      // mark's 0,0; the S's origin is S_AT on the foot, and the slant is
      // undone, since the clip is drawn before the letter's transform
      const local = ([x, y]: number[]) =>
        s ? [ox + (x - S_AT - SLANT * (y - LOGO_H)) * u, oy + (y - LOGO_H) * u] : [ox + x * u, capTop + y * u]
      const poly = (pts: number[][]) =>
        `polygon(${pts
          .map(local)
          .map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`)
          .join(', ')})`
      return {
        origin: `${ox.toFixed(1)}px ${oy.toFixed(1)}px`,
        at: `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${k.toFixed(4)}) skewX(${s ? S_SKEW : 0}deg)`,
        home: 'translate(0px, 0px) scale(1) skewX(0deg)',
        cut: poly(s ? S_CUT : W_CUT),
        open: poly(s ? S_OPEN : W_OPEN),
      }
    }
    const rest = (which: 'mark' | 'word') => {
      stop()
      letters.forEach((n, i) => {
        n.style.transform = ''
        n.style.clipPath = ''
        n.style.opacity = which === 'word' || i === 0 || i === 4 ? '1' : '0'
      })
      if (which === 'mark') {
        const pw = pose(lw, false)
        const ps = pose(ls, true)
        lw.style.transformOrigin = pw.origin
        lw.style.transform = pw.at
        lw.style.clipPath = pw.cut
        ls.style.transformOrigin = ps.origin
        ls.style.transform = ps.at
        ls.style.clipPath = ps.cut
      }
      if (tag) tag.style.opacity = which === 'word' ? '1' : '0'
    }
    // from layout, not the screen: W and S may stand in their mark pose
    const dx = (i: number, src: number) => `translateX(${letters[src].offsetLeft - letters[i].offsetLeft}px)`
    // W and S between their pose in the mark and their place in the word
    const travel = (toWord: boolean, delay: number, duration: number, easing: string) => {
      const pw = pose(lw, false)
      const ps = pose(ls, true)
      lw.style.transformOrigin = pw.origin
      ls.style.transformOrigin = ps.origin
      const w = [
        { transform: pw.at, clipPath: pw.cut },
        { transform: pw.home, clipPath: pw.open },
      ]
      const sk = [
        { transform: ps.at, clipPath: ps.cut },
        { transform: ps.home, clipPath: ps.open },
      ]
      return [
        run(lw, toWord ? w : w.toReversed(), { duration, delay, easing }),
        run(ls, toWord ? sk : sk.toReversed(), { duration, delay: delay + 30, easing }),
      ]
    }
    const unfold = async (move: Move) => {
      stop()
      const jobs: Promise<unknown>[] = []
      {
        jobs.push(...travel(true, 0, 420, EASE_OUT))
        const from = (i: number, src: number) => (move === 'unfold' ? dx(i, src) : 'translateY(60%)')
        ;[1, 2, 3].forEach((i, k) =>
          jobs.push(
            run(
              letters[i],
              [
                { opacity: 0, transform: from(i, 0) },
                { opacity: 1, transform: 'none' },
              ],
              { duration: 420, delay: 140 + k * 30, easing: EASE_OUT },
            ),
          ),
        )
        ;[5, 6, 7].forEach((i, k) =>
          jobs.push(
            run(
              letters[i],
              [
                { opacity: 0, transform: from(i, 4) },
                { opacity: 1, transform: 'none' },
              ],
              { duration: 420, delay: 170 + k * 30, easing: EASE_OUT },
            ),
          ),
        )
      }
      if (tag) {
        const lift = kind === 'ruby' ? 'translateY(4px)' : 'translateY(-4px)'
        jobs.push(
          run(
            tag,
            [
              { opacity: 0, transform: lift },
              { opacity: 1, transform: 'none' },
            ],
            { duration: 240, delay: 480, easing: EASE_OUT },
          ),
        )
      }
      await Promise.all(jobs)
      if (alive()) rest('word')
    }

    const fold = async (move: Move) => {
      stop()
      const jobs: Promise<unknown>[] = []
      if (tag) jobs.push(run(tag, [{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: EASE_IN }))
      {
        ;[1, 2, 3, 5, 6, 7].forEach((i) =>
          jobs.push(
            run(
              letters[i],
              [
                { opacity: 1, transform: 'none' },
                { opacity: 0, transform: move === 'unfold' ? dx(i, i < 4 ? 0 : 4) : 'translateY(60%)' },
              ],
              { duration: 200, easing: EASE_IN },
            ),
          ),
        )
        // the rest folds into W and S while those two take their mark pose
        jobs.push(...travel(false, 100, 300, EASE_OUT))
      }
      await Promise.all(jobs)
      if (alive()) rest('mark')
    }

    const mount = lastKey.current === null || lastKey.current === replayKey
    lastKey.current = replayKey ?? ''
    // no WAAPI (old engines, jsdom): the rest, like motion off
    if (still() || typeof word.animate !== 'function') {
      rest('word')
      setHeroMark(false)
      return
    }
    // Page changes in quick succession ride along with the run already under
    // way: cutting it short snapped the letters and the slogan back to the
    // wordmark mid-fold, a flash on every click, and the next run began again
    if (running.current) return
    const seq = async () => {
      const move = pick(MOVES)
      if (variant === 'hero') {
        // the large mark draws itself in, then hands over to W and S in
        // their mark pose - the same shape - which unfold
        rest('word')
        letters.forEach((n) => (n.style.opacity = '0'))
        if (tag) tag.style.opacity = '0'
        await wait(DURATION[intro] + 120)
        if (!alive()) return
        rest('mark')
        setHeroMark(false)
        await wait(60)
        if (alive()) await unfold(move)
        return
      }
      if (mount) {
        rest('mark')
        await wait(350)
      } else {
        // a frame after the page change: the fold measures the letters and
        // reads their animations, which inside the commit that mounts the
        // new page forced its whole style and layout
        await new Promise((r) => requestAnimationFrame(r))
        if (!alive()) return
        await fold(move)
        await wait(450)
      }
      if (alive()) await unfold(move)
    }
    running.current = true
    void seq().finally(() => (running.current = false))
    // the hero runs once; the rail on every new key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayKey])

  const ch = (c: string, i: number) => (
    <span key={i} data-ch className="inline-block">
      {c}
    </span>
  )
  const ruby = slogan && kind === 'ruby' && (
    <span
      data-slogan
      aria-hidden
      className="pointer-events-none absolute right-[0.2em] bottom-full left-0 mb-0.5 flex justify-between font-mono text-[max(0.38em,10px)] leading-none font-normal tracking-normal text-accent/80"
    >
      {/* drawn by CSS, not text: decoration that must not join the link's name */}
      {[...slogan].map((c, i) => (
        <span key={i} data-c={c} className="before:content-[attr(data-c)]" />
      ))}
    </span>
  )
  const sub = slogan && kind === 'sub' && (
    <span
      data-slogan
      aria-hidden
      className="pointer-events-none absolute top-full right-[0.2em] mt-1.5 flex items-center gap-2 font-mono text-[max(0.4em,10px)] leading-none font-normal tracking-[0.35em] text-t-muted before:h-0.5 before:w-[1.5em] before:rounded-full before:bg-accent"
    >
      {slogan}
    </span>
  )
  // where the mark stands and how large: an empty box of the mark's
  // proportions, measured, never painted - W and S pose into it
  const anchor = (
    <svg
      data-anchor
      aria-hidden
      viewBox={`0 0 ${LOGO_W} ${LOGO_H}`}
      className={`pointer-events-none invisible absolute top-1/2 w-auto -translate-y-1/2 text-accent ${
        variant === 'hero' ? 'left-1/2 h-14 -translate-x-1/2' : 'left-0 h-[1.15em]'
      }`}
    />
  )

  const wordmark = (
    <span data-word className="relative inline-block whitespace-nowrap text-accent" aria-label="WeebSync" role="img">
      {[...'WEEB'].map(ch)}
      <span className="relative text-accent-2">
        {[...'SYNC'].map((c, i) => ch(c, i + 4))}
        {ruby}
      </span>
      {sub}
    </span>
  )

  // the about page names the app: the wordmark alone, the mark is for small places
  if (variant === 'about') return <div className={className}>{wordmark}</div>
  return (
    <div
      ref={root}
      className={`relative ${variant === 'hero' ? 'grid h-20 place-items-center' : 'inline-block'} ${className}`}
    >
      {wordmark}
      {anchor}
      {heroMark && (
        <Logo
          intro={intro}
          className="pointer-events-none absolute top-1/2 left-1/2 h-14 w-auto -translate-x-1/2 -translate-y-1/2 text-accent"
        />
      )}
    </div>
  )
}
