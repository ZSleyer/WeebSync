import { FileRow } from '@weebsync/design-system'

export const Entries = () => (
  <div style={{ maxWidth: 480, border: '1px solid var(--border-subtle)' }}>
    <FileRow icon="📁" name="2026-3 Summer" detail="12 Ordner" />
    <FileRow icon="📁" name="Endless Anime" detail="4 Ordner" selected />
    <FileRow icon="🎬" name="One Piece E1156 [1080p][GerSub].mkv" detail="1,4 GiB" />
    <FileRow icon="🎬" name="One Piece E1155 [1080p][GerSub].mkv" detail="1,3 GiB" />
  </div>
)
