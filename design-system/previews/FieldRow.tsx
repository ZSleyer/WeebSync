import { Field, FieldRow, Input, Select } from '@weebsync/design-system'

export const TwoColumns = () => (
  <div style={{ maxWidth: 560, display: 'grid', gap: 12 }}>
    <FieldRow>
      <Field label="Dub-Sprache (nur herunterladen, wenn vorhanden)">
        <Select defaultValue=""><option value="">Beliebig</option></Select>
      </Field>
      <Field label="Sub-Sprache">
        <Select defaultValue=""><option value="">Beliebig</option></Select>
      </Field>
    </FieldRow>
    <FieldRow>
      <Field label="Host">
        <Input className="font-mono" defaultValue="anime-server" />
      </Field>
      <Field label="Port">
        <Input className="font-mono" type="number" defaultValue={22} />
      </Field>
    </FieldRow>
  </div>
)
