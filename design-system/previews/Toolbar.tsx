import { Badge, Button, Checkbox, Input, Select, Toolbar } from '@weebsync/design-system'

export const FilterRow = () => (
  <Toolbar style={{ maxWidth: 720 }}>
    <Input placeholder="Warteschlange durchsuchen…" style={{ width: 200 }} />
    <span style={{ width: 150 }}>
      <Select defaultValue="all">
        <option value="all">Alle Server</option>
        <option value="anime">anime-server</option>
      </Select>
    </span>
    <Button size="sm">Alle starten</Button>
    <Badge tone="ok">3 aktiv</Badge>
    <Checkbox label="Nur Fehler" />
  </Toolbar>
)
