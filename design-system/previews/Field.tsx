import { Field, FieldRow, Input, Select } from '@weebsync/design-system'

export const Row = () => (
  <FieldRow>
    <Field label="Metadatenquelle">
      <Select defaultValue="anilist">
        <option value="anilist">AniList (Anime)</option>
        <option value="tmdb">TMDB Serie</option>
      </Select>
    </Field>
    <Field label="Media-ID (für Cover und Episodenliste, optional)">
      <Input defaultValue="21" />
    </Field>
  </FieldRow>
)

export const Single = () => (
  <div style={{ maxWidth: 320 }}>
    <Field label="Auto-Sync-Prüfintervall (Minuten)">
      <Input type="number" defaultValue={30} />
    </Field>
  </div>
)
