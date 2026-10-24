import { useState, type CSSProperties } from 'react'
import { coverHue } from 'fluid-lycoris'
import { lowData, type ImgSet } from '../images'

const loaded = (img: HTMLImageElement | null) => {
  if (img?.complete && img.naturalWidth > 0) img.dataset.loaded = ''
}

export interface SmartImgProps {
  set?: ImgSet
  /** the rendered width, for the browser's pick from the set */
  sizes: string
  alt?: string
  /** first-screen pictures load eagerly; the first of them with high priority */
  eager?: boolean
  priority?: boolean
  className?: string
  /** the picture itself (not the small preview) could not be loaded */
  onFail?: () => void
}

/**
 * The pictures of one image, for inside a frame that fades its `img`
 * children in on `data-loaded` (the design system's `.t-cover`): the small
 * size first, the set over it once loaded, so a sharp cover replaces a soft
 * one without a layout shift. On a slow or data-saving connection only the
 * small one loads.
 */
export function SmartImg({ set, sizes, alt = '', eager, priority, className, onFail }: SmartImgProps) {
  if (!set) return null
  const common = {
    loading: eager ? ('eager' as const) : ('lazy' as const),
    decoding: 'async' as const,
    ref: loaded,
    onLoad: (e: { currentTarget: HTMLImageElement }) => {
      e.currentTarget.dataset.loaded = ''
    },
  }
  const stack: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }
  // a picture that failed before hydration never fires `error` for React to hear:
  // it is already complete with no width, so the ref callback reports it
  const main = {
    ...common,
    onError: onFail,
    ref: (img: HTMLImageElement | null) => {
      loaded(img)
      if (img?.complete && img.naturalWidth === 0 && img.getAttribute('src')) onFail?.()
    },
  }
  if (set.small && lowData()) return <img {...main} alt={alt} src={set.small} className={className} style={stack} />
  return (
    <>
      {set.small && <img {...common} alt="" aria-hidden src={set.small} className={className} style={stack} />}
      <img
        {...main}
        alt={alt}
        src={set.src}
        srcSet={set.srcSet}
        sizes={set.srcSet ? sizes : undefined}
        // the attribute is lower case in the DOM; React 19 knows the prop
        fetchPriority={priority ? 'high' : undefined}
        className={className}
        style={stack}
      />
    </>
  )
}

export interface CoverImgProps extends Omit<SmartImgProps, 'className'> {
  /** the poster's own colour, standing in until it loads */
  tint?: string | null
  /** the title, drawn on a hue of its own when there is no picture */
  title?: string
  className?: string
  style?: CSSProperties
}

/**
 * A cover frame (`.t-cover`: rounded, no ring, hover zoom and press sink
 * inside a button) with the picture in every size the API delivered.
 */
export function CoverImg({ set, tint, title, className = '', style, ...img }: CoverImgProps) {
  // a cover that 404s or is blocked would stay a blank tile: the title stands in
  const [failed, setFailed] = useState<string>()
  if (!set || failed === set.src) {
    return (
      <span
        className={`t-cover t-cover--fallback ${className}`}
        style={{ '--h': coverHue(title ?? ''), ...style } as CSSProperties}
      >
        {title && <b aria-hidden>{title}</b>}
      </span>
    )
  }
  return (
    <span
      className={`t-cover ${className}`}
      style={{ ...(tint ? { '--cover-tint': tint } : {}), ...style } as CSSProperties}
    >
      <SmartImg set={set} {...img} onFail={() => setFailed(set.src)} />
    </span>
  )
}
