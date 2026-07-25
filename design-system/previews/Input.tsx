import { Input } from '@weebsync/design-system'

export const Text = () => (
  <div style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
    <Input defaultValue="anime-server" />
    <Input placeholder="Hostname eintragen…" />
  </div>
)

export const Monospace = () => (
  <div style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
    <Input className="font-mono" defaultValue="/Anime/One Piece" />
    <Input className="font-mono" defaultValue="{title} - S{season:02}E{episode:02}" />
  </div>
)

export const States = () => (
  <div style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
    <Input type="number" defaultValue={30} />
    <Input defaultValue="Von der Umgebung gesetzt" disabled />
  </div>
)
