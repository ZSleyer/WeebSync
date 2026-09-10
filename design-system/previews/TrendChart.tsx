import { Badge, Panel, TrendChart } from '@weebsync/design-system'

// ten minutes of a download at one sample a second: a slow start, a plateau, a dip
const samples = Array.from({ length: 600 }, (_, i) => {
  const t = i / 600
  const base = t < 0.1 ? t * 10 : 1
  const dip = t > 0.6 && t < 0.7 ? 0.3 : 1
  return Math.round(base * dip * (2.4 + Math.sin(i / 9) * 0.2) * 1024 * 1024)
})
const fmt = (v: number) => `${(v / 1024 / 1024).toFixed(1)} MiB/s`
const age = (s: number) => (s === 0 ? 'jetzt' : `vor ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`)

/** The dashboard's speed panel: the figure, then the last ten minutes under it. Hover or touch to read a sample. */
export const Speed = () => (
  <Panel className="px-4 py-3 text-accent" style={{ maxWidth: 420 }}>
    <Badge>Speed</Badge>
    <p className="mt-1 font-mono text-lg text-t-primary tabular-nums">2,4 MiB/s</p>
    <p className="text-[11px] text-t-muted">über 3 Downloads</p>
    <TrendChart className="mt-3" values={samples} label="Gesamtgeschwindigkeit, letzte 10 Minuten" format={fmt} formatAge={age} startLabel="vor 10 min" endLabel="jetzt" />
  </Panel>
)

/** Before the second sample there is nothing to draw: the frame keeps its size. */
export const Empty = () => (
  <div className="text-accent" style={{ maxWidth: 420 }}>
    <TrendChart values={[0]} label="Gesamtgeschwindigkeit" format={fmt} formatAge={age} startLabel="vor 10 min" endLabel="jetzt" />
  </div>
)

export const LightMode = () => (
  <div data-theme="light" style={{ background: 'var(--bg-primary)', padding: 12, maxWidth: 420 }}>
    <Speed />
  </div>
)
