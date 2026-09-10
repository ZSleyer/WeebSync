import { Sparkline } from '@weebsync/design-system'

const rising = [2, 3, 3, 5, 4, 6, 8, 7, 9, 12, 11, 14]
const flat = [5, 5, 5, 5, 5, 5, 5, 5]

/** Accent from the surrounding text colour; the figure next to it is the label. */
export const Rising = () => (
  <div className="text-accent" style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
    <span className="font-mono text-lg text-t-primary">2,4 MiB/s</span>
    <Sparkline values={rising} label="Gesamtgeschwindigkeit, letzte 60 Sekunden" />
  </div>
)

export const Flat = () => (
  <div className="text-t-muted">
    <Sparkline values={flat} label="Gesamtgeschwindigkeit, letzte 60 Sekunden" />
  </div>
)

/** Below two samples there is nothing to draw: the box keeps its size, the line waits. */
export const Empty = () => (
  <div className="text-accent" style={{ outline: '1px dashed var(--border-subtle)', width: 96 }}>
    <Sparkline values={[3]} label="Gesamtgeschwindigkeit, letzte 60 Sekunden" />
  </div>
)
