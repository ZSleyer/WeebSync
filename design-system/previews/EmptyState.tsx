import { EmptyState } from '@weebsync/design-system'

export const NoWatches = () => (
  <div style={{ maxWidth: 520 }}>
    <EmptyState label="Auto-Sync">
      Noch keine Ordner überwacht. Wähle in der Remote-Ansicht einen Ordner und lege eine Regel an.
    </EmptyState>
  </div>
)

export const NoDownloads = () => (
  <div style={{ maxWidth: 520 }}>
    <EmptyState>Keine aktiven Downloads.</EmptyState>
  </div>
)
