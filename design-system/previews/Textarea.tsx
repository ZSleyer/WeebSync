import { Field, Textarea } from '@weebsync/design-system'

// Same box as Input - border, focus ring, padding and the disabled look all
// come from .t-input, only the height grows with `rows`.

export const Text = () => (
  <div style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
    <Textarea rows={3} defaultValue={'Neue Folge verfügbar\nOne Piece 1157 liegt auf anime-server'} />
    <Textarea rows={3} placeholder="Notiz zu dieser Regel…" />
  </div>
)

/** The multi-line values the app really stores: one path mapping per line. */
export const Monospace = () => (
  <div style={{ maxWidth: 360 }}>
    <Field label="Plex-Pfadzuordnung">
      <Textarea
        className="font-mono"
        rows={3}
        defaultValue={'/media/anime => /library/anime\n/media/serien => /library/serien'}
      />
    </Field>
  </div>
)

export const States = () => (
  <div style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
    <Textarea rows={2} defaultValue="Von der Umgebung gesetzt" disabled />
  </div>
)
