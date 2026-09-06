import { NavItem } from '@weebsync/design-system'

export const Sidebar = () => (
  <nav style={{ maxWidth: 220, background: 'var(--bg-secondary)', paddingBlock: 8 }}>
    <NavItem icon="▣">Dashboard</NavItem>
    <NavItem icon="↻" active>Auto-Sync</NavItem>
    <NavItem icon="✦">Vorschläge</NavItem>
    <NavItem icon="▤">Dateien</NavItem>
    <NavItem icon="⚙">Einstellungen</NavItem>
  </nav>
)

// The settings hub: one row per section, a hint under the label, a chevron at
// the right edge. Rows are separated by hairlines rather than gaps.
export const Rows = () => (
  <nav style={{ maxWidth: 380 }}>
    <NavItem variant="row" icon="◐" trailing="›">
      <span className="flex min-w-0 flex-col">
        <span>Allgemein</span>
        <span className="text-xs font-sans text-t-muted">Design, Sprache, Version</span>
      </span>
    </NavItem>
    <NavItem variant="row" icon="⚇" trailing="›" active>
      <span className="flex min-w-0 flex-col">
        <span>Konto</span>
        <span className="text-xs font-sans text-t-muted">Passkeys, Zwei-Faktor</span>
      </span>
    </NavItem>
    <NavItem variant="row" icon="🔔" trailing="›">
      Benachrichtigungen
    </NavItem>
  </nav>
)

// The overflow sheet on a phone, plus the tab that opens it: a button, not a
// link, because it navigates nowhere.
export const SheetAndButton = () => (
  <div style={{ maxWidth: 380 }}>
    <NavItem variant="sheet" icon="✎" trailing="›">
      Umbenennen
    </NavItem>
    <NavItem variant="sheet" icon="⚙" trailing="›" active>
      Einstellungen
    </NavItem>
    <div className="flex border-t border-border-subtle">
      <NavItem variant="bottomTab" href="#" active>
        Dashboard
      </NavItem>
      <NavItem variant="bottomTab" as="button" aria-haspopup="dialog" aria-expanded={false}>
        Mehr
      </NavItem>
    </div>
  </div>
)
