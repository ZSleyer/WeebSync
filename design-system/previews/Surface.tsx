import { Badge, Button, Panel, Surface } from '@weebsync/design-system'

export const Dark = () => (
  <Surface>
    <Panel className="p-4">
      <Badge tone="accent">Dunkel</Badge>
      <p className="mt-2 text-sm text-t-secondary">Die Grundfläche, auf der WeebSync gebaut ist.</p>
      <div className="mt-3 flex gap-2">
        <Button size="sm">Abbrechen</Button>
        <Button size="sm" variant="primary" cut>Speichern</Button>
      </div>
    </Panel>
  </Surface>
)

export const Light = () => (
  <Surface theme="light">
    <Panel className="p-4">
      <Badge tone="accent">Hell</Badge>
      <p className="mt-2 text-sm text-t-secondary">Dieselbe Fläche, helle Palette - Kontraste bleiben AA.</p>
      <div className="mt-3 flex gap-2">
        <Button size="sm">Abbrechen</Button>
        <Button size="sm" variant="primary" cut>Speichern</Button>
      </div>
    </Panel>
  </Surface>
)
