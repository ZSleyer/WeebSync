import { NavItem } from '@weebsync/design-system'

export const Sidebar = () => (
  <nav style={{ maxWidth: 220, background: 'var(--bg-secondary)', paddingBlock: 8 }}>
    <NavItem icon="▣">Dashboard</NavItem>
    <NavItem icon="▤">Lokal</NavItem>
    <NavItem icon="☁">Remote</NavItem>
    <NavItem icon="↻" active>Auto-Sync</NavItem>
    <NavItem icon="✦">Vorschläge</NavItem>
    <NavItem icon="⚙">Einstellungen</NavItem>
  </nav>
)
