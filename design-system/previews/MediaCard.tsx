import { Badge, Button, MediaCard } from '@weebsync/design-system'

// Data-URI poster in an arbitrary ratio - the frame crops it, the layout must not move.
const poster = (w: number, h: number, label: string, hue: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<rect width="${w}" height="${h}" fill="hsl(${hue} 45% 32%)"/>` +
      `<text x="50%" y="50%" fill="white" font-family="sans-serif" font-size="${Math.round(Math.min(w, h) / 6)}" text-anchor="middle" dominant-baseline="middle">${label}</text>` +
      `</svg>`,
  )}`


const COVER_OP = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg'
const COVER_DC = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx235-MyYT7K3chBdO.jpg'

export const Watched = () => (
  <MediaCard
    cover={COVER_OP}
    title="One Piece"
    path="anime-server:/Anime/One Piece → /media/anime/One Piece/Staffel 23"
    meta="Letzter Abgleich: vor 4 Minuten (2 Dateien eingereiht)"
    badges={
      <>
        <Badge tone="ok">Folge 1157 · Sonntag 09:30</Badge>
        <Badge>Umbenennen</Badge>
      </>
    }
    actions={
      <>
        <Button size="sm">Jetzt prüfen</Button>
        <Button size="sm">Bearbeiten</Button>
        <Button size="sm" variant="danger">Löschen</Button>
      </>
    }
  />
)

export const Behind = () => (
  <MediaCard
    cover={COVER_DC}
    title="Detektiv Conan"
    path="anime-server:/Anime/Detective Conan → /media/anime/Detektiv Conan"
    meta="Letzter Abgleich: vor 28 Minuten"
    badges={
      <>
        <Badge tone="warn">3 Folgen ausstehend</Badge>
        <Badge tone="err">Lücke: 1148, 1149</Badge>
      </>
    }
    actions={<Button size="sm">Jetzt prüfen</Button>}
  />
)

export const WithoutCover = () => (
  <MediaCard
    title="Filme"
    path="anime-server:/Anime/Movies → /media/anime/Filme"
    meta="Letzter Abgleich: vor 1 Stunde"
    badges={<Badge>Ohne Umbenennung</Badge>}
    actions={<Button size="sm">Bearbeiten</Button>}
  />
)

/** Same tile, three poster ratios: the row height never changes. */
export const AnyPosterRatio = () => (
  <div style={{ display: 'grid', gap: 8 }}>
    <MediaCard title="Hochformat 2:3" cover={poster(460, 650, '2:3', 265)} path="server:/A → /media/A" meta="Letzter Abgleich: vor 5 Minuten" />
    <MediaCard title="Breitformat 4:1" cover={poster(1200, 300, 'breit', 190)} path="server:/B → /media/B" meta="Letzter Abgleich: vor 12 Minuten" />
    <MediaCard title="Winziges Bild 64px" cover={poster(64, 64, '64', 90)} path="server:/C → /media/C" meta="Letzter Abgleich: vor 1 Stunde" />
  </div>
)

/** The same card on a light surface - tokens flip, contrast holds. */
export const LightMode = () => (
  <div data-theme="light" style={{ background: 'var(--bg-primary)', padding: 12 }}>
    <MediaCard
      title="One Piece"
      cover={COVER_OP}
      path="anime-server:/Anime/One Piece → /media/anime/One Piece"
      meta="Letzter Abgleich: vor 4 Minuten"
      badges={<><Badge tone="ok">Folge 1157</Badge><Badge tone="warn">1 ausstehend</Badge></>}
      actions={<Button size="sm">Jetzt prüfen</Button>}
    />
  </div>
)
