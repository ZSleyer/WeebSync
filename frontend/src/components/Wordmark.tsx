// The wordmark. Stacked, WEEB stands over SYNC with every letter in the
// column of the one above - a four-column grid does what the display face,
// which is not monospaced, would not - so the app bar spends two short
// rows on it instead of one long one.
export default function Wordmark({ stacked, className = '' }: { stacked?: boolean; className?: string }) {
  if (!stacked) {
    return (
      <span className={`font-display font-bold tracking-[0.2em] text-t-primary ${className}`}>
        WEEB<span className="text-accent">SYNC</span>
      </span>
    )
  }
  return (
    <span aria-hidden className={`grid grid-cols-[repeat(4,auto)] gap-x-[0.08em] font-display font-bold leading-none text-t-primary ${className}`}>
      {['W', 'E', 'E', 'B'].map((c, i) => (
        <span key={`w${i}`} className="text-center">
          {c}
        </span>
      ))}
      {['S', 'Y', 'N', 'C'].map((c, i) => (
        <span key={`s${i}`} className="text-center text-accent">
          {c}
        </span>
      ))}
    </span>
  )
}
