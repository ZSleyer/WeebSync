import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigationType } from 'react-router'
import { useMediaQuery } from 'fluid-lycoris'
import { api } from '../../api'
import type { Schemas } from '../../api.gen'
import { useSeriesModal } from '../../components/SeriesModal'
import { deal, nextPattern, PATTERNS, placed, shapes, type Panel } from './banner'

type Banner = Schemas['api.todayBanner']
type Banners = Schemas['api.todayBannersResponse']

/** a phone shows one banner across the whole box */
export const PHONE_HERO_MQ = '(max-width: 719px)'
const LAST_KEY = 'weebsync.today.pattern'
const NO_BANNERS: Banners = { banners: [], watches: 1 }

// how a refresh's new page takes over from the old one: drawn anew each
// time, a plain fade where motion is turned down
const BLENDS = ['zoom', 'blur', 'dots', 'wipe', 'duo', 'push'] as const
function pickBlend(): string {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'fade'
  return BLENDS[Math.floor(Math.random() * BLENDS.length)]
}

// the deal last shown: a step back in history to the page shows it again
// (same banners from the cache, same cut) instead of fetching and decoding
// a new set while the page comes back
interface Deal {
  visit: number
  seeds: { last: number; a: number; b: number }
}
let lastDeal: Deal | null = null

// the pattern shown last, across reloads of the tab: the next visit draws another
function lastPattern(): number {
  try {
    return Number(sessionStorage.getItem(LAST_KEY) ?? -1)
  } catch {
    return -1
  }
}
function rememberPattern(n: number) {
  try {
    sessionStorage.setItem(LAST_KEY, String(n))
  } catch {
    /* storage blocked: the draw still avoids a repeat within the visit */
  }
}

export interface HeroBannerProps {
  /** the caption's lines: date, then what is going on */
  date: string
  status: ReactNode[]
  /** while loading the counts, the status line holds its place */
  statusLoading?: boolean
}

/**
 * The Today page's hero: a manga page cut from the banners of the user's
 * series, a new cut on every visit, a caption box with the date and what is
 * going on. A panel opens its series; the series card morphs out of it
 * (the card's provider names the pair) while the caption steps aside.
 */
export function HeroBanner({ date, status, statusLoading }: HeroBannerProps) {
  const { t } = useTranslation()
  const phone = useMediaQuery(PHONE_HERO_MQ)
  // a new draw per visit: the key changes with every mount, except on a
  // step back in history, which returns to the page as it was
  const navType = useNavigationType()
  const [deal0] = useState<Deal>(() =>
    navType === 'POP' && lastDeal
      ? lastDeal
      : { visit: Date.now(), seeds: { last: lastPattern(), a: Math.random(), b: Math.random() } },
  )
  useEffect(() => {
    lastDeal = deal0
  }, [deal0])
  const { visit, seeds } = deal0
  const {
    data: got,
    isPending,
    isError,
  } = useQuery<Banners>({
    queryKey: ['today', 'banners', visit],
    queryFn: () => api.get('/api/today/banners'),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: 1,
  })
  // no answer is no picture: the page is drawn in tone panels
  const data = got ?? (isError ? NO_BANNERS : undefined)
  const [failed, setFailed] = useState<Set<string>>(new Set())
  const usable = useMemo(() => (data?.banners ?? []).filter((b) => !failed.has(`${b.source}|${b.id}`)), [data, failed])
  // the cut: one pattern per visit and layout (crossing to a phone deals again)
  // the draws of this visit, taken once: a cut for the desktop page, one for
  // the phone's single banner, so crossing the breakpoint deals anew
  const cut = useMemo(
    () =>
      data
        ? {
            pattern: nextPattern(seeds.last, () => (phone ? seeds.b : seeds.a)),
            phone,
            pick: Math.floor((phone ? seeds.a : seeds.b) * Math.max(1, data.banners.length)),
          }
        : null,
    [data, phone, seeds],
  )
  useEffect(() => {
    if (cut) rememberPattern(cut.pattern)
  }, [cut])

  const pageRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ w: number; h: number; r: number } | null>(null)
  useLayoutEffect(() => {
    const el = pageRef.current
    if (!el) return
    const measure = () => {
      const r = parseFloat(getComputedStyle(el.parentElement!).borderTopLeftRadius) || 0
      setBox((b) =>
        b && b.w === el.clientWidth && b.h === el.clientHeight && b.r === r
          ? b
          : { w: el.clientWidth, h: el.clientHeight, r },
      )
    }
    // the observer reports once after the first layout: measuring right here
    // forced a layout of the page being mounted. The panels slide in only
    // after the deal anyway, so the frame without them is never seen.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // the caption steps aside while a panel's series opens, and back in as
  // it closes: named for the transition from the click until the card is
  // gone again
  const caption = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const cardOpen = !!(location.state as { wsTitle?: unknown } | null)?.wsTitle
  const named = useRef(false)
  useEffect(() => {
    if (cardOpen || !named.current) return
    const id = setTimeout(() => {
      if (caption.current) caption.current.style.viewTransitionName = ''
      named.current = false
    }, 900)
    return () => clearTimeout(id)
  }, [cardOpen])
  const { open } = useSeriesModal()
  const openPanel = (b: Banner) => {
    if (caption.current) caption.current.style.viewTransitionName = 'fl-cap'
    named.current = true
    open({ source: b.source, id: b.id })
  }

  // the panels slide in once, after the first paint of the dealt page
  const [enter, setEnter] = useState(false)
  const dealt = !!(cut && box && data)
  // and only once their pictures are decoded (at most 250ms): a slide over
  // pictures still decoding waited on the raster threads frame by frame
  useEffect(() => {
    if (!dealt) return
    let gone = false
    let a = 0
    let b = 0
    const imgs = [...(pageRef.current?.querySelectorAll('img') ?? [])]
    void Promise.race([
      Promise.all(imgs.map((i) => (i.decode ? i.decode().catch(() => {}) : null))),
      new Promise((r) => setTimeout(r, 250)),
    ]).then(() => {
      if (gone) return
      a = requestAnimationFrame(() => (b = requestAnimationFrame(() => setEnter(true))))
    })
    return () => {
      gone = true
      cancelAnimationFrame(a)
      cancelAnimationFrame(b)
    }
  }, [dealt])

  const panels = useMemo(() => {
    if (!cut || !box || !box.w || !box.h || !data) return []
    if (cut.phone) {
      // one picture across the box, in full colour
      const b = usable.length ? usable[cut.pick % usable.length] : null
      return [
        {
          key: 'one',
          b,
          tone: 'plain' as const,
          dots: 'to top',
          fill: 'half-teal' as const,
          style: { inset: 0 } as CSSProperties,
          k: 0,
          phone: true,
        },
      ]
    }
    const pt = PATTERNS[cut.pattern]
    const list = deal<Banner>(pt, usable)
    const polys = shapes(pt, list as Panel<unknown>[], box.w, box.h, 8, box.r)
    return list.map((p, k) => {
      const at = placed(polys[k], box.w, box.h)
      return {
        key: `${k}`,
        b: p.b,
        tone: p.tone,
        dots: p.dots,
        fill: p.fill,
        k,
        phone: false,
        style: { left: at.left, top: at.top, width: at.width, height: at.height, clipPath: at.clip } as CSSProperties,
      }
    })
  }, [cut, box, data, usable])

  // a refresh deals new banners: the old page stays on top and leaves over
  // the new one (already decoded by the refresh) instead of swapping in one
  // frame. A resize or a dropped picture redraws without it.
  const [seen, setSeen] = useState({ data, panels })
  const [gone, setGone] = useState<{ panels: typeof panels; blend: string } | null>(null)
  if (seen.panels !== panels) {
    setSeen({ data, panels })
    if (enter && seen.data && data && seen.data !== data && seen.panels.length)
      setGone({ panels: seen.panels, blend: pickBlend() })
  }
  useEffect(() => {
    if (!gone) return
    const id = setTimeout(() => setGone(null), 1000)
    return () => clearTimeout(id)
  }, [gone])

  const art = (b: Banner, p: (typeof panels)[number], onError?: () => void) => (
    <span
      className="t-art"
      data-duo={p.tone === 'plain' ? undefined : p.tone === 'red' ? 'accent' : 'accent-2'}
      style={{ '--tone-dir': p.dots } as CSSProperties}
    >
      <img
        src={b.url}
        alt=""
        decoding="async"
        loading="eager"
        fetchPriority={p.k === 0 ? 'high' : undefined}
        onError={onError}
      />
      {!p.phone && <i aria-hidden className="t-art-dots" />}
    </span>
  )

  const noWatches = data?.watches === 0
  return (
    <div
      className="td-hero"
      data-enter={enter || undefined}
      data-loading={isPending || undefined}
      data-blend={gone?.blend}
    >
      <div ref={pageRef} className="td-page" role="group" aria-label={t('today.bannerLabel')}>
        {panels.map((p) => {
          const style = { ...p.style, '--k': p.k } as CSSProperties
          if (!p.b) return <span key={p.key} aria-hidden className="td-pn td-tone" data-fill={p.fill} style={style} />
          const b = p.b
          return (
            <button
              key={p.key}
              type="button"
              className="td-pn"
              data-band=""
              data-tone={p.tone}
              data-phone={p.phone || undefined}
              aria-label={t('today.openSeries', { title: b.title })}
              onClick={() => openPanel(b)}
              style={style}
            >
              {art(b, p, () => setFailed((f) => new Set(f).add(`${b.source}|${b.id}`)))}
            </button>
          )
        })}
        {gone?.panels.map((p) => (
          <span
            key={`gone-${p.key}`}
            aria-hidden
            className={p.b ? 'td-pn td-gone' : 'td-pn td-tone td-gone'}
            data-fill={p.b ? undefined : p.fill}
            data-tone={p.b ? p.tone : undefined}
            data-phone={p.phone || undefined}
            style={p.style}
          >
            {p.b && art(p.b, p)}
          </span>
        ))}
      </div>
      <div ref={caption} className="td-cap">
        <p className="td-date t-wipe" style={{ '--i': 0 } as CSSProperties}>
          {date}
        </p>
        {noWatches ? (
          <p className="td-cta t-wipe" style={{ '--i': 1 } as CSSProperties}>
            <span>{t('today.ctaText')}</span>
            <Link to="/watches" className="t-btn t-btn--primary">
              {t('today.ctaButton')}
            </Link>
          </p>
        ) : (
          <p
            className="td-status t-wipe"
            style={{ '--i': 1 } as CSSProperties}
            data-loading={statusLoading || undefined}
          >
            {status.map((s, i) => (
              <span key={i}>
                {i > 0 && <i aria-hidden />}
                {s}
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  )
}
