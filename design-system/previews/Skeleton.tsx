import { Panel, Skeleton } from '@weebsync/design-system'

export const Shapes = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
    <Skeleton shape="cover" size="sm" />
    <Skeleton shape="cover" />
    <Skeleton shape="cover" size="lg" />
    <div style={{ width: 160, display: 'grid', gap: 8 }}>
      <Skeleton />
      <Skeleton className="w-2/3" />
      <Skeleton shape="block" className="h-2 w-full" />
    </div>
  </div>
)

/**
 * What the transfer queue shows before its first answer: a hero-shaped card
 * and two rows. The container pulses and carries the status role; the pieces
 * are hidden from assistive tech.
 */
export const HeroCard = () => (
  <div role="status" aria-label="Lädt" className="animate-pulse" style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
    <Panel className="flex gap-4 p-4">
      <Skeleton shape="cover" />
      <div className="min-w-0 flex-1 space-y-2.5 py-1">
        <Skeleton className="w-2/3" />
        <Skeleton className="w-1/3" />
        <Skeleton shape="block" className="mt-4 h-2 w-full" />
      </div>
    </Panel>
    <Panel className="flex gap-3 p-3">
      <Skeleton shape="cover" size="sm" />
      <div className="min-w-0 flex-1 space-y-2 py-1">
        <Skeleton className="w-1/2" />
        <Skeleton shape="block" className="h-1 w-full" />
      </div>
    </Panel>
  </div>
)

export const LightMode = () => (
  <div data-theme="light" style={{ background: 'var(--bg-primary)', padding: 12, maxWidth: 480 }}>
    <HeroCard />
  </div>
)
