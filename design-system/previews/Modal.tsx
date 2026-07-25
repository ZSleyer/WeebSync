import { Button, Field, FieldRow, Input, Modal, Select } from '@weebsync/design-system'

export const EditDialog = () => (
  <Modal
    title="Auto-Sync bearbeiten"
    info="Quelle: /Anime/One Piece · Ziel: /media/anime/One Piece"
    footer={
      <>
        <Button size="sm">Abbrechen</Button>
        <Button size="sm" variant="primary" cut>Speichern</Button>
      </>
    }
  >
    <FieldRow>
      <Field label="Metadatenquelle">
        <Select defaultValue="anilist">
          <option value="anilist">AniList (Anime)</option>
          <option value="tmdb">TMDB Serie</option>
        </Select>
      </Field>
      <Field label="Media-ID (optional)">
        <Input defaultValue="21" />
      </Field>
    </FieldRow>
    <FieldRow>
      <Field label="Dub-Sprache">
        <Select defaultValue="">
          <option value="">Beliebig</option>
          <option value="Ger">Ger</option>
        </Select>
      </Field>
      <Field label="Sub-Sprache">
        <Select defaultValue="">
          <option value="">Beliebig</option>
          <option value="Ger">Ger</option>
        </Select>
      </Field>
    </FieldRow>
  </Modal>
)

export const Confirm = () => (
  <Modal
    title="Auto-Sync löschen"
    footer={
      <>
        <Button size="sm">Behalten</Button>
        <Button size="sm" variant="danger">Löschen</Button>
      </>
    }
  >
    <p className="text-sm text-t-secondary">
      Die Regel für „One Piece" wird entfernt. Bereits heruntergeladene Dateien bleiben erhalten.
    </p>
  </Modal>
)
