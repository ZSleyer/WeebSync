import { Badge, Button, SuggestionCard } from '@weebsync/design-system'

export const FromWatchlist = () => (
  <SuggestionCard
    title="Frieren: Nach dem Ende der Reise"
    year={2023}
    badges={<><Badge tone="accent">Watchlist</Badge><Badge>AniList</Badge></>}
    detail="Steht auf deiner Merkliste und liegt auf dem Server bereit."
    actions={<><Button size="sm" variant="primary" cut>Synchronisieren</Button><Button size="sm">Ignorieren</Button></>}
  />
)

export const Upgrade = () => (
  <SuggestionCard
    cover="https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21355-wRVUrGxpvIQQ.jpg"
    title="Re:Zero - Starting Life in Another World"
    year={2016}
    badges={<><Badge tone="warn">Bessere Quelle</Badge><Badge tone="ok">1080p statt 720p</Badge></>}
    detail="Lokal in 720p, auf dem Server als 1080p mit deutschem Ton verfügbar."
    actions={<Button size="sm" variant="primary" cut>Ersetzen</Button>}
  />
)

export const Incomplete = () => (
  <SuggestionCard
    title="Mushoku Tensei"
    year={2021}
    badges={<Badge tone="err">Staffel unvollständig</Badge>}
    detail="14 von 23 Folgen lokal vorhanden."
    actions={<Button size="sm">Fehlende laden</Button>}
  />
)
