import { Radio } from '@weebsync/design-system'

export const WithLabels = () => (
  <div style={{ display: 'grid', gap: 8 }}>
    <Radio name="preview-a" label="Empfohlene Version" defaultChecked />
    <Radio name="preview-a" label="Anime-Server" />
    <Radio name="preview-a" label="Lokal (Plex)" />
    <Radio name="preview-a" label="Von der Umgebung gesetzt" disabled />
  </div>
)

/**
 * A group needs a fieldset and a legend, not just a shared name: that is what
 * announces the choice as one question instead of four loose controls.
 * labelClassName styles the row, min-w-0 so a long path truncates instead of
 * pushing the chips next to it out of the row.
 */
export const InGroup = () => (
  <fieldset style={{ border: 0, padding: 0, maxWidth: 320 }}>
    <legend className="t-label">Version wählen</legend>
    <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
      <Radio
        name="preview-b"
        labelClassName="min-w-0 text-t-secondary"
        label={<span className="truncate font-mono text-[11px]">/BD [FTP-Exclusive]/Golden Time</span>}
        defaultChecked
      />
      <Radio
        name="preview-b"
        labelClassName="min-w-0 text-t-secondary"
        label={<span className="truncate font-mono text-[11px]">/BD [Fansub &amp; Remux]/Golden Time</span>}
      />
    </div>
  </fieldset>
)

export const Bare = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Radio name="preview-c" defaultChecked />
    <Radio name="preview-c" />
    <Radio name="preview-d" disabled />
  </div>
)
