import { Breadcrumb, FileBrowser, FileRow } from '@weebsync/design-system'

export const Listing = () => (
  <div style={{ maxWidth: 520 }}>
    <FileBrowser breadcrumb={<Breadcrumb segments={['Anime', '2026-3 Summer']} />}>
      <FileRow icon="📁" name="Clevatess II [GerJapDub,GerEngSub]" detail="8 Dateien" />
      <FileRow icon="📁" name="Kill Blue [JapDub,GerSub]" detail="5 Dateien" selected />
      <FileRow icon="📁" name="Witch Hat Atelier [GerJapDub]" detail="3 Dateien" />
      <FileRow icon="🎬" name="Clevatess E05 [GerJapDub].mkv" detail="1,1 GiB" />
    </FileBrowser>
  </div>
)

export const Empty = () => (
  <div style={{ maxWidth: 520 }}>
    <FileBrowser breadcrumb={<Breadcrumb segments={['Anime', 'Leerer Ordner']} />} empty="Ordner ist leer." >
      <span />
    </FileBrowser>
  </div>
)
