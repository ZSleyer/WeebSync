import { useLayoutEffect, useRef, useState } from 'react'
import { LOGO_H, LOGO_PATH_S, LOGO_PATH_W, LOGO_W } from '../logo'
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
// - `about`: mark over wordmark, still - the one place both stand.
//
// Each run picks one of three moves at random: unfold (the letters glide out
// of W and S), roll (they roll up one by one, like the app's numbers) or cut
// (the intro's slanted blade sweeps the wordmark in over the mark). The
// slogan sits under SYNC like a subtitle or over it like furigana, drawn per
// mount, and never covers the mark. Motion runs on WAAPI with transform,
// opacity and clip-path only; motion off shows each place's rest at once.

type Move = 'unfold' | 'roll' | 'cut'
const MOVES: Move[] = ['unfold', 'roll', 'cut']
type Slogan = 'sub' | 'ruby'
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'
const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)'
// where each half's glyph centre sits across the mark's box
const GLYPH_W = 314 / LOGO_W
const GLYPH_S = 788 / LOGO_W
// Chakra Petch caps stand about this high in the em
const CAP = 0.72
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
  // the hero's intro plays on the full Logo; the halves take over to unfold
  const [heroMark, setHeroMark] = useState(variant === 'hero')
  // the key the last run was for: the same key again is a remount (or React's
  // strict double run), not a page change
  const lastKey = useRef<string | undefined | null>(null)

  useLayoutEffect(() => {
    const el = root.current
    if (!el || variant === 'about') return
    const q = <T extends Element>(s: string) => [...el.querySelectorAll<T>(s)]
    const letters = q<HTMLElement>('[data-ch]')
    const word = el.querySelector<HTMLElement>('[data-word]')!
    const halves = q<SVGSVGElement>('[data-half]')
    const tag = el.querySelector<HTMLElement>('[data-slogan]')
    const all = [word, ...letters, ...halves, ...(tag ? [tag] : [])]
    let alive = true
    const stop = () => all.forEach((n) => n.getAnimations?.().forEach((a) => a.cancel()))
    const rest = (which: 'mark' | 'word') => {
      stop()
      letters.forEach((n) => (n.style.opacity = which === 'word' ? '1' : '0'))
      halves.forEach((n) => (n.style.opacity = which === 'mark' ? '1' : '0'))
      if (tag) tag.style.opacity = which === 'word' ? '1' : '0'
    }
    const run = (n: Element, k: Keyframe[], o: KeyframeAnimationOptions & { duration: number }) =>
      n.animate(k, { fill: 'both', ...o }).finished.catch(() => {})
    // a half's glyph onto the cap box of its letter
    const flip = (m: SVGSVGElement, letter: HTMLElement, glyph: number) => {
      m.style.transformOrigin = `${glyph * 100}% 50%`
      const mb = m.getBoundingClientRect()
      const lb = letter.getBoundingClientRect()
      const cs = getComputedStyle(letter)
      const k = (parseFloat(cs.fontSize) * CAP) / mb.height
      const lx = lb.left + (lb.width - (parseFloat(cs.letterSpacing) || 0)) / 2
      const gx = mb.left + mb.width * glyph
      return `translate(${(lx - gx).toFixed(1)}px, ${(lb.top + lb.height / 2 - (mb.top + mb.height / 2)).toFixed(1)}px) scale(${k.toFixed(3)})`
    }
    const dx = (i: number, src: number) =>
      `translateX(${(letters[src].getBoundingClientRect().left - letters[i].getBoundingClientRect().left).toFixed(1)}px)`
    const slant = (x: number, keepLeft: boolean) =>
      keepLeft
        ? `polygon(-20% 0, ${x}% 0, ${x - 18}% 100%, -20% 100%)`
        : `polygon(${x}% 0, 140% 0, 140% 100%, ${x - 18}% 100%)`

    const unfold = async (move: Move) => {
      stop()
      const [mw, ms] = halves
      const jobs: Promise<unknown>[] = []
      if (move === 'cut') {
        letters.forEach((n) => (n.style.opacity = '1'))
        jobs.push(
          run(word, [{ clipPath: slant(-10, true) }, { clipPath: slant(130, true) }], {
            duration: 620,
            easing: EASE_OUT,
          }),
        )
        halves.forEach((h) =>
          jobs.push(
            run(
              h,
              [
                { clipPath: slant(-10, false), opacity: 1 },
                { clipPath: slant(130, false), opacity: 1 },
              ],
              { duration: 620, easing: EASE_OUT },
            ),
          ),
        )
      } else {
        const tw = flip(mw, letters[0], GLYPH_W)
        const ts = flip(ms, letters[4], GLYPH_S)
        jobs.push(
          run(
            mw,
            [
              { transform: 'none', opacity: 1 },
              { transform: tw, opacity: 1, offset: 0.75 },
              { transform: tw, opacity: 0 },
            ],
            { duration: 360, easing: EASE_OUT },
          ),
        )
        jobs.push(
          run(
            ms,
            [
              { transform: 'none', opacity: 1 },
              { transform: ts, opacity: 1, offset: 0.75 },
              { transform: ts, opacity: 0 },
            ],
            { duration: 380, delay: 30, easing: EASE_OUT },
          ),
        )
        ;[0, 4].forEach((i, k) =>
          jobs.push(
            run(letters[i], [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: 260 + k * 30, easing: 'linear' }),
          ),
        )
        const from = (i: number, src: number) => (move === 'unfold' ? dx(i, src) : 'translateY(60%)')
        ;[1, 2, 3].forEach((i, k) =>
          jobs.push(
            run(
              letters[i],
              [
                { opacity: 0, transform: from(i, 0) },
                { opacity: 1, transform: 'none' },
              ],
              { duration: 420, delay: 300 + k * 30, easing: EASE_OUT },
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
              { duration: 420, delay: 330 + k * 30, easing: EASE_OUT },
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
            { duration: 240, delay: move === 'cut' ? 560 : 640, easing: EASE_OUT },
          ),
        )
      }
      await Promise.all(jobs)
      if (alive) rest('word')
    }

    const fold = async (move: Move) => {
      stop()
      const [mw, ms] = halves
      const jobs: Promise<unknown>[] = []
      if (tag) jobs.push(run(tag, [{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: EASE_IN }))
      if (move === 'cut') {
        jobs.push(
          run(word, [{ clipPath: slant(-10, false) }, { clipPath: slant(130, false) }], {
            duration: 260,
            easing: EASE_IN,
          }),
        )
        halves.forEach((h) =>
          jobs.push(
            run(
              h,
              [
                { clipPath: slant(-10, true), opacity: 1 },
                { clipPath: slant(130, true), opacity: 1 },
              ],
              { duration: 260, easing: EASE_IN },
            ),
          ),
        )
      } else {
        const tw = flip(mw, letters[0], GLYPH_W)
        const ts = flip(ms, letters[4], GLYPH_S)
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
        ;[0, 4].forEach((i) =>
          jobs.push(run(letters[i], [{ opacity: 1 }, { opacity: 0 }], { duration: 90, delay: 160, easing: 'linear' })),
        )
        jobs.push(
          run(
            mw,
            [
              { transform: tw, opacity: 0 },
              { transform: tw, opacity: 1, offset: 0.3 },
              { transform: 'none', opacity: 1 },
            ],
            { duration: 260, delay: 160, easing: EASE_OUT },
          ),
        )
        jobs.push(
          run(
            ms,
            [
              { transform: ts, opacity: 0 },
              { transform: ts, opacity: 1, offset: 0.3 },
              { transform: 'none', opacity: 1 },
            ],
            { duration: 260, delay: 170, easing: EASE_OUT },
          ),
        )
      }
      await Promise.all(jobs)
      if (alive) rest('mark')
    }

    const mount = lastKey.current === null || lastKey.current === replayKey
    lastKey.current = replayKey ?? ''
    // no WAAPI (old engines, jsdom): the rest, like motion off
    if (still() || typeof word.animate !== 'function') {
      rest('word')
      setHeroMark(false)
      return
    }
    const seq = async () => {
      const move = pick(MOVES)
      if (variant === 'hero') {
        // the large mark draws itself in, then hands over to its halves -
        // the same pixels - which unfold
        rest('word')
        letters.forEach((n) => (n.style.opacity = '0'))
        if (tag) tag.style.opacity = '0'
        await wait(DURATION[intro] + 120)
        if (!alive) return
        rest('mark')
        setHeroMark(false)
        await wait(60)
        if (alive) await unfold(move)
        return
      }
      if (mount) {
        rest('mark')
        await wait(350)
      } else {
        await fold(move)
        await wait(450)
      }
      if (alive) await unfold(move)
    }
    seq()
    return () => {
      alive = false
      // a new page mid-move: the next run starts from the wordmark at rest
      rest('word')
    }
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
      {[...slogan].map((c, i) => (
        <span key={i}>{c}</span>
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
  const half = (d: string, fill: string) => (
    <svg
      data-half
      aria-hidden
      viewBox={`0 0 ${LOGO_W} ${LOGO_H}`}
      className={`pointer-events-none absolute top-1/2 w-auto -translate-y-1/2 overflow-visible opacity-0 ${
        variant === 'hero' ? 'left-1/2 h-14 -translate-x-1/2' : 'left-0 h-[1.15em]'
      }`}
    >
      <path d={d} fill={fill} />
    </svg>
  )

  const wordmark = (
    <span data-word className="relative inline-block whitespace-nowrap" aria-label="WeebSync" role="img">
      {[...'WEEB'].map(ch)}
      <span className="relative text-accent">
        {[...'SYNC'].map((c, i) => ch(c, i + 4))}
        {ruby}
      </span>
      {sub}
    </span>
  )

  if (variant === 'about') {
    return (
      <div className={`flex flex-col items-start gap-3 ${className}`}>
        <Logo play={false} className="h-10 w-auto" />
        {wordmark}
      </div>
    )
  }
  return (
    <div
      ref={root}
      className={`relative ${variant === 'hero' ? 'grid h-20 place-items-center' : 'inline-block'} ${className}`}
    >
      {wordmark}
      {half(LOGO_PATH_W, 'currentColor')}
      {half(LOGO_PATH_S, 'var(--accent-blue)')}
      {heroMark && (
        <Logo
          intro={intro}
          className="pointer-events-none absolute top-1/2 left-1/2 h-14 w-auto -translate-x-1/2 -translate-y-1/2"
        />
      )}
    </div>
  )
}
