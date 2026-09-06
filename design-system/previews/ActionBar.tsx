import { ActionBar, AppBar, AppShell, Badge, Button, NavItem, Panel, TabBar } from '@weebsync/design-system'

// Sticky inside the shell's scroller: scroll the frame and the bar stays at
// the bottom edge, above the tab bar, until the page ends.
export const SelectionBar = () => (
  <div style={{ width: 380, height: 560, overflow: 'hidden' }}>
    <AppShell
      bar={<AppBar title="Dashboard" />}
      tabs={
        <TabBar aria-label="Hauptnavigation">
          <div className="flex">
            <NavItem variant="bottomTab" active href="#">
              Dashboard
            </NavItem>
            <NavItem variant="bottomTab" href="#">
              Dateien
            </NavItem>
          </div>
        </TabBar>
      }
    >
      <div className="flex flex-col gap-2">
        {Array.from({ length: 12 }, (_, i) => (
          <Panel key={i} className="p-3 text-sm">
            Download {i + 1}
          </Panel>
        ))}
        <ActionBar aria-label="Auswahl">
          <Badge tone="accent">3 gewählt</Badge>
          <Button size="sm">Pause</Button>
          <Button size="sm">Fortsetzen</Button>
          <Button size="sm" variant="danger">
            Abbrechen
          </Button>
        </ActionBar>
      </div>
    </AppShell>
  </div>
)

// The save bar of a settings form: sticky on a phone, in flow after the
// panels on desktop.
export const SaveBar = () => (
  <div style={{ maxWidth: 380 }}>
    <Panel className="p-4">Formular</Panel>
    <ActionBar aria-label="Speichern" className="lg:static lg:border-0 lg:bg-transparent lg:p-0">
      <Button variant="primary" cut>
        Speichern
      </Button>
      <Badge tone="ok">Gespeichert</Badge>
    </ActionBar>
  </div>
)
