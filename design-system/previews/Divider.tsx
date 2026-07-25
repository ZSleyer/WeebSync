import { Divider } from '@weebsync/design-system'

export const WithCount = () => (
  <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
    <Divider label="Überwacht" count={12} />
    <Divider label="Wartet" count={4} />
    <Divider label="Komplett" count={31} />
  </div>
)

export const WithLink = () => (
  <div style={{ maxWidth: 520 }}>
    <Divider
      label="Sync-Übersicht"
      trailing={
        <a
          href="#"
          style={{ display: 'inline-flex', alignItems: 'center', minHeight: 24, fontSize: 11, color: 'var(--accent-blue)' }}
        >
          Alle anzeigen →
        </a>
      }
    />
  </div>
)
