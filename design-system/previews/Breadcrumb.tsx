import { Breadcrumb, Button } from 'fluid-lycoris'

export const RemotePath = () => (
  <div style={{ maxWidth: 520 }}>
    <Breadcrumb segments={['Anime', '2026-3 Summer', 'One Piece']} />
  </div>
)

export const WithAction = () => (
  <div style={{ maxWidth: 520 }}>
    <Breadcrumb segments={['media', 'anime', 'One Piece']} trailing={<Button size="sm">Bearbeiten</Button>} />
  </div>
)

export const AtRoot = () => (
  <div style={{ maxWidth: 520 }}>
    <Breadcrumb segments={[]} />
  </div>
)
