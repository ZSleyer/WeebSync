// Image sizes by device. AniList hands out each picture in fixed sizes whose
// URLs cannot be derived from one another (large is only 230px wide), so the
// API delivers every size and these helpers turn them into a srcset the
// browser picks from by rendered width and pixel density.

/** A picture in several widths: the small one shows first, the set fades in over it. */
export interface ImgSet {
  /** the fallback src: the middle size, for engines without srcset */
  src: string
  /** `url 230w, url 460w`; absent when there is only one size */
  srcSet?: string
  /** the smallest size, painted first and kept on slow or data-saving connections */
  small?: string
}

// AniList's widths: covers medium 100, large 230, extraLarge 460;
// characters and staff medium 100, large 230
const COVER_W = { medium: 100, large: 230, extraLarge: 460 } as const
const PERSON_W = { medium: 100, large: 230 } as const

function setOf(sizes: [string | undefined | null, number][]): ImgSet | undefined {
  const have = sizes.filter((s): s is [string, number] => !!s[0])
  if (!have.length) return undefined
  // unique urls only: a cache from before the sizes arrived repeats one
  const uniq = have.filter(([u], i) => have.findIndex(([v]) => v === u) === i)
  const mid = uniq.find(([, w]) => w >= 200) ?? uniq[uniq.length - 1]
  return {
    src: mid[0],
    srcSet: uniq.length > 1 ? uniq.map(([u, w]) => `${u} ${w}w`).join(', ') : undefined,
    small: uniq.length > 1 ? uniq[0][0] : undefined,
  }
}

/** A cover's sizes (medium, large, extraLarge), as AniList and the API name them. */
export function coverSet(c?: { medium?: string; large?: string; extraLarge?: string } | null): ImgSet | undefined {
  if (!c) return undefined
  return setOf([
    [c.medium, COVER_W.medium],
    [c.large, COVER_W.large],
    [c.extraLarge, COVER_W.extraLarge],
  ])
}

/** A character's or person's portrait sizes. */
export function personSet(medium?: string, large?: string): ImgSet | undefined {
  return setOf([
    [medium, PERSON_W.medium],
    [large, PERSON_W.large],
  ])
}

/**
 * A slow or data-saving connection stays on the small picture. Read once per
 * call: the Network Information API is Chromium only, elsewhere this is false.
 */
export function lowData(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  return !!c && (!!c.saveData || /(^|-)(2g|3g)$/.test(c.effectiveType ?? ''))
}
