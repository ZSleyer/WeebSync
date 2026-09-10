import { Badge, Button, TransferCard } from '@weebsync/design-system'

const poster = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="460" height="650"><rect width="460" height="650" fill="hsl(265 45% 32%)"/></svg>',
)}`

const actions = (
  <>
    <Button size="sm" className="shrink-0">Pause</Button>
    <Button size="sm" variant="danger" className="shrink-0">Abbrechen</Button>
  </>
)

/** The transfer in progress: poster, series, episode, the stats line, then the bar. */
export const Hero = () => (
  <div style={{ maxWidth: 560 }}>
    <TransferCard
      cover={poster}
      title="Sousou no Frieren"
      subtitle="[Group] Sousou no Frieren - 12 (1080p).mkv"
      badges={
        <>
          <Badge tone="accent">läuft</Badge>
          <Badge tone="accent">S01E12</Badge>
        </>
      }
      meta="2023 · Madhouse · 91 %"
      stats="1,2 GiB / 4,0 GiB · 2,4 MiB/s · in 4 Min"
      percent={30}
      progressLabel="Fortschritt Sousou no Frieren S01E12"
      active
      actions={actions}
    />
  </div>
)

/** Everything queued behind it, at list density with the thin bar. */
export const Rows = () => (
  <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
    <TransferCard
      variant="row"
      cover={poster}
      title="Sousou no Frieren"
      badges={<Badge>wartet</Badge>}
      stats="0 B / 4,1 GiB"
      percent={0}
      progressLabel="Fortschritt Sousou no Frieren S01E13"
      actions={actions}
    />
    <TransferCard
      variant="row"
      title="[Group] Some Show - 03.mkv"
      badges={<Badge tone="warn">Versuch 2, erneut in 40 s</Badge>}
      stats="812 MiB / 1,4 GiB"
      percent={58}
      progressLabel="Fortschritt Some Show 03"
      actions={actions}
    />
  </div>
)

/** A selected row takes the hover ground, the way a selected history row does. */
export const Selected = () => (
  <div style={{ maxWidth: 560 }}>
    <TransferCard
      variant="row"
      selected
      leading={<input type="checkbox" checked readOnly aria-label="Sousou no Frieren auswählen" />}
      cover={poster}
      title="Sousou no Frieren"
      badges={<Badge tone="accent">S01E12</Badge>}
      stats="1,2 GiB / 4,0 GiB"
      percent={30}
      progressLabel="Fortschritt Sousou no Frieren S01E12"
      active
    />
  </div>
)

export const LightMode = () => (
  <div data-theme="light" style={{ background: 'var(--bg-primary)', padding: 12, maxWidth: 560 }}>
    <Hero />
  </div>
)
