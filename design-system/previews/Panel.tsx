import { Badge, Panel } from '@weebsync/design-system'

export const Standard = () => (
  <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
    <Panel className="p-5">
      <Badge tone="accent">Server</Badge>
      <p className="mt-2 text-sm text-t-secondary">
        Standardfläche für Formulare und Einstellungen: Hairline-Rahmen, Radius aus --r-panel.
      </p>
    </Panel>
  </div>
)

export const Danger = () => (
  <div style={{ maxWidth: 420 }}>
    <Panel danger className="p-5">
      <Badge tone="err">Gefahrenzone</Badge>
      <p className="mt-2 text-sm text-t-secondary">Ein rot getönter Rahmen markiert zerstörende Bereiche.</p>
    </Panel>
  </div>
)

export const Compact = () => (
  <div style={{ maxWidth: 420 }}>
    <Panel className="p-3">
      <span className="text-sm text-t-secondary">Kompakte Listenkachel mit p-3.</span>
    </Panel>
  </div>
)

export const LightMode = () => (
  <div data-theme="light" style={{ background: 'var(--bg-primary)', padding: 12, maxWidth: 420 }}>
    <Panel className="p-5">
      <Badge tone="accent">Server</Badge>
      <p className="mt-2 text-sm text-t-secondary">Dieselbe Fläche auf hellem Grund.</p>
    </Panel>
  </div>
)
