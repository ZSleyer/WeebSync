import { Progress, Sparkline, StatTile } from '@weebsync/design-system'

const samples = [0, 0, 1, 2, 2, 3, 3, 2, 4, 5, 4, 6]

/** The dashboard's speed figure with the last minute beside it. */
export const Speed = () => (
  <div style={{ maxWidth: 320 }}>
    <StatTile
      label="Speed"
      value="2,4 MiB/s"
      detail="über 3 Downloads"
      trend={<Sparkline values={samples} label="Gesamtgeschwindigkeit, letzte 60 Sekunden" className="text-accent" />}
    />
  </div>
)

/** Two tiles in a two-column aside: each keeps its own column, a wide one spans both. */
export const Pair = () => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, maxWidth: 320 }}>
    <StatTile label="Speed" value="2,4 MiB/s" />
    <StatTile label="Restzeit" value="in 4 Min" detail="3,1 GiB offen" />
    <StatTile wide label="Speicher" value="1,2 TiB frei" detail="von 4,0 TiB" trend={<Progress value={70} tone="ok" label="Speicher, 70 % belegt" className="w-24" />} />
  </div>
)

export const LightMode = () => (
  <div data-theme="light" style={{ background: 'var(--bg-primary)', padding: 12, maxWidth: 320 }}>
    <StatTile
      label="Speed"
      value="2,4 MiB/s"
      detail="über 3 Downloads"
      trend={<Sparkline values={samples} label="Gesamtgeschwindigkeit, letzte 60 Sekunden" className="text-accent" />}
    />
  </div>
)
