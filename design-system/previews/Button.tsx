import { Button } from '@weebsync/design-system'

export const Variants = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Button>Abbrechen</Button>
    <Button variant="primary">Speichern</Button>
    <Button variant="danger">Löschen</Button>
  </div>
)

/**
 * Three steps. "xs" is not a smaller box - it keeps the small button's height,
 * and therefore its touch target, and only shrinks type and side padding. It
 * exists for a labelled button inside a card too narrow for the small size,
 * where the alternative is the label breaking across two lines.
 */
export const Sizes = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Button>Standard</Button>
    <Button size="sm">Klein</Button>
    <Button size="sm" variant="primary">Klein primär</Button>
    <Button size="xs">Match ändern</Button>
  </div>
)

export const Disabled = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Button disabled>Nicht verfügbar</Button>
    <Button variant="primary" disabled>Wird gespeichert…</Button>
  </div>
)

/** Every weight on a light surface. */
export const LightMode = () => (
  <div data-theme="light" style={{ background: 'var(--bg-primary)', padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
    <Button>Abbrechen</Button>
    <Button variant="primary">Speichern</Button>
    <Button variant="danger">Löschen</Button>
    <Button size="sm">Klein</Button>
  </div>
)
