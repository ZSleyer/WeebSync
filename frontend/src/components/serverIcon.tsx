import { Box, Cloud, Database, Film, Globe, HardDrive, Rocket, SatelliteDish, Server, Tv, type LucideProps } from 'lucide-react'

// The pictures a server may pick for the source switch, keyed by the name the
// backend stores (its allowlist mirrors this map). The local library always
// draws the hard drive.
export const SERVER_ICONS = {
  server: Server,
  cloud: Cloud,
  'hard-drive': HardDrive,
  database: Database,
  globe: Globe,
  'satellite-dish': SatelliteDish,
  box: Box,
  rocket: Rocket,
  tv: Tv,
  film: Film,
} as const

export type ServerIconName = keyof typeof SERVER_ICONS

export function ServerIcon({ name, ...rest }: { name: string } & LucideProps) {
  const Icon = SERVER_ICONS[name as ServerIconName]
  return Icon ? <Icon {...rest} /> : null
}
