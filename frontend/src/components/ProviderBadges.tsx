import { ExternalLink } from 'lucide-react'
import { Badge } from '@weebsync/design-system'
import type { ProviderLinks } from '../api'

const PROVIDER_LABEL: Record<string, string> = {
  anilist: 'AniList',
  tmdb: 'TMDB',
  tvdb: 'TVDB',
  imdb: 'IMDb',
  plex: 'Plex',
}

// ProviderBadges shows which integrations recognise the title; each links to
// that provider's page when a URL is known.
export function ProviderBadges({ providers, links }: { providers: string[]; links: ProviderLinks }) {
  return (
    <>
      {providers.map((p) => {
        const url = (links as Record<string, string | undefined>)[p]
        const label = PROVIDER_LABEL[p] ?? p
        return url ? (
          // no anchor variant of Badge in the design system, so the linked chip
          // keeps the class directly
          <a key={p} className="t-label hover:text-accent" href={url} target="_blank" rel="noreferrer">
            {label} <ExternalLink aria-hidden size="1em" className="inline align-[-0.125em]" />
          </a>
        ) : (
          <Badge key={p}>{label}</Badge>
        )
      })}
    </>
  )
}
