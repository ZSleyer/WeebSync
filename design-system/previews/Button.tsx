import { Button } from '@weebsync/design-system'

export const Variants = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Button>Abbrechen</Button>
    <Button variant="primary" cut>Speichern</Button>
    <Button variant="danger">Löschen</Button>
  </div>
)

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Button>Standard</Button>
    <Button size="sm">Klein</Button>
    <Button size="sm" variant="primary">Klein primär</Button>
  </div>
)

export const Disabled = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Button disabled>Nicht verfügbar</Button>
    <Button variant="primary" cut disabled>Wird gespeichert…</Button>
  </div>
)

/**
 * The clipped corner. Its outline is one ring, so the diagonal is part of the
 * contour instead of a gap in it - on every weight, at every pixel ratio.
 */
export const CutCorner = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Button cut>Übernehmen</Button>
    <Button variant="primary" cut>Speichern</Button>
    <Button variant="danger" cut>Endgültig löschen</Button>
  </div>
)

/** Every weight on a light surface. */
export const LightMode = () => (
  <div data-theme="light" style={{ background: 'var(--bg-primary)', padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
    <Button>Abbrechen</Button>
    <Button variant="primary" cut>Speichern</Button>
    <Button variant="danger">Löschen</Button>
    <Button size="sm">Klein</Button>
  </div>
)
