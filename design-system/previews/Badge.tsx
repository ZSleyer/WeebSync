import { Badge, Checkbox, Input } from '@weebsync/design-system'

export const Tones = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Badge>Umbenennen</Badge>
    <Badge tone="accent">Überwacht</Badge>
    <Badge tone="ok">Komplett</Badge>
    <Badge tone="warn">3 Folgen ausstehend</Badge>
    <Badge tone="err">Lücke: 1148</Badge>
  </div>
)

export const InContext = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 20 }}>
    <span style={{ color: 'var(--text-secondary)' }}>Neben großem Text:</span>
    <Badge tone="accent">Gleiche Höhe</Badge>
    <Badge tone="ok">Unabhängig vom Kontext</Badge>
  </div>
)

/** Chips that lead to the provider page: as="a" makes them real links. */
export const Links = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Badge as="a" href="https://anilist.co/anime/21" target="_blank" rel="noreferrer" className="hover:text-accent">
      AniList ↗
    </Badge>
    <Badge as="a" href="https://www.thetvdb.com/series/one-piece" target="_blank" rel="noreferrer" className="hover:text-accent">
      TVDB ↗
    </Badge>
  </div>
)

/**
 * Filter chips toggle, so they have to be buttons carrying aria-pressed. Every
 * chip is at least 24px tall, which is what the interactive ones need
 * (WCAG 2.5.8) - the decorative ones simply match.
 */
export const Filters = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Badge as="button" tone="accent" aria-pressed className="cursor-pointer">Fertig</Badge>
    <Badge as="button" aria-pressed={false} className="cursor-pointer">Abgebrochen</Badge>
    <Badge as="button" aria-pressed={false} className="cursor-pointer">Fehler</Badge>
  </div>
)

/** The chip's element follows its role: day heading, section heading, caption. */
export const Semantics = () => (
  <div style={{ display: 'grid', gap: 12, maxWidth: 320 }}>
    <Badge as="h3" tone="accent" className="w-fit">Sonntag, 27.07.</Badge>
    <Badge as="h4" className="w-fit">Beschreibung</Badge>
    <fieldset style={{ border: '1px solid var(--border-subtle)', padding: 12 }}>
      <Badge as="legend">Zwei-Faktor-Anmeldung</Badge>
      <Checkbox label="Mit Authenticator-App bestätigen" defaultChecked />
    </fieldset>
    <div>
      <Badge as="label" htmlFor="badge-host" className="mb-1 block w-fit">Host</Badge>
      <Input id="badge-host" className="font-mono" defaultValue="anime-server" />
    </div>
  </div>
)

export const LightMode = () => (
  <div data-theme="light" style={{ background: 'var(--bg-primary)', padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
    <Badge>Umbenennen</Badge>
    <Badge tone="accent">Überwacht</Badge>
    <Badge tone="ok">Komplett</Badge>
    <Badge tone="warn">Ausstehend</Badge>
    <Badge tone="err">Lücke</Badge>
  </div>
)
