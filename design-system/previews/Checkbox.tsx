import { Checkbox } from '@weebsync/design-system'

export const WithLabels = () => (
  <div style={{ display: 'grid', gap: 8 }}>
    <Checkbox label="In Unterordner speichern (benannt nach dem Remote-Ordner)" defaultChecked />
    <Checkbox label="Registrierung nach der Einrichtung schließen" defaultChecked />
    <Checkbox label="Dateien umbenennen" />
    <Checkbox label="Von der Umgebung gesetzt" disabled />
  </div>
)

/**
 * labelClassName styles the row around box and text: muted for a settings
 * toggle, and min-w-0 so a long library name truncates instead of pushing the
 * chips next to it out of the row.
 */
export const InRows = () => (
  <div style={{ display: 'grid', gap: 8, maxWidth: 300 }}>
    <Checkbox label="Push-Benachrichtigungen aktivieren" labelClassName="text-t-secondary" defaultChecked />
    <Checkbox
      labelClassName="min-w-0 text-t-secondary"
      label={<span className="truncate">Anime (Filme, Specials und OVAs)</span>}
      defaultChecked
    />
  </div>
)

export const Bare = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Checkbox defaultChecked />
    <Checkbox />
    <Checkbox disabled />
  </div>
)
