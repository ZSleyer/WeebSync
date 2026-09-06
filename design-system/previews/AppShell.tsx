import { AppBar, AppShell, Button, IconButton, NavItem, Panel, TabBar } from '@weebsync/design-system'

// A phone-sized frame around the shell: the point of the component is that the
// bars are rows of a box exactly one viewport tall, so it only shows anything
// when it has a viewport to fill.
const frame = { width: 380, height: 640, overflow: 'hidden', resize: 'both' } as const

const tabs = (
  <TabBar aria-label="Hauptnavigation">
    <div className="flex">
      <NavItem variant="bottomTab" active href="#">
        Dashboard
      </NavItem>
      <NavItem variant="bottomTab" href="#">
        Auto-Sync
      </NavItem>
      <NavItem variant="bottomTab" href="#">
        Vorschläge
      </NavItem>
      <NavItem variant="bottomTab" href="#">
        Dateien
      </NavItem>
      <NavItem variant="bottomTab" as="button" aria-haspopup="dialog" aria-expanded={false}>
        Mehr
      </NavItem>
    </div>
  </TabBar>
)

// A root tab: mark, title, the page's secondary controls at the right.
export const PhoneShell = () => (
  <div style={frame}>
    <AppShell
      bar={
        <AppBar
          leading={<span aria-hidden className="font-display text-xs font-bold tracking-[0.2em] text-accent">WS</span>}
          title="Auto-Sync"
          actions={
            <>
              <IconButton aria-label="Kalender">▦</IconButton>
              <IconButton aria-label="Sortieren">↕</IconButton>
            </>
          }
        />
      }
      tabs={tabs}
    >
      <Panel className="p-4">Seiteninhalt - scrollt, die Leisten bleiben stehen.</Panel>
    </AppShell>
  </div>
)

// A stacked screen (a settings section) with a back link, and the notice row
// the update toast uses: a shell row above the tab bar, not a fixed box.
export const PhoneShellNested = () => (
  <div style={frame}>
    <AppShell
      bar={<AppBar leading={<IconButton aria-label="Zurück">←</IconButton>} title="Benachrichtigungen" />}
      notice={
        <Panel className="flex items-center justify-between gap-3 border-accent/60 p-3 text-sm">
          Neue Version verfügbar
          <Button size="sm" variant="primary">
            Neu laden
          </Button>
        </Panel>
      }
      tabs={tabs}
    >
      <Panel className="p-4">Formular</Panel>
    </AppShell>
  </div>
)
