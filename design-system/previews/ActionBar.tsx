import { ActionBar, AppBar, AppShell, Badge, Button, NavItem, Panel, TabBar } from '@weebsync/design-system'

// The shell's footer row: the bar sits on the tab bar whether the page is
// shorter or longer than the frame. The app portals a page's bar in there
// below lg and renders it as the footer of the panel it acts on from lg on.
export const SelectionBar = () => (
  <div style={{ width: 380, height: 560, overflow: 'hidden' }}>
    <AppShell
      bar={<AppBar title="Dashboard" />}
      footer={
        <ActionBar aria-label="Auswahl">
          <Badge tone="accent">3 gewählt</Badge>
          <Button size="sm">Pause</Button>
          <Button size="sm">Fortsetzen</Button>
          <Button size="sm" variant="danger">
            Abbrechen
          </Button>
        </ActionBar>
      }
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
      </div>
    </AppShell>
  </div>
)

// The save bar of a settings form: the footer row on a phone, in flow after
// the panels on desktop.
export const SaveBar = () => (
  <div style={{ maxWidth: 380 }}>
    <Panel className="p-4">Formular</Panel>
    <ActionBar aria-label="Speichern" sticky={false}>
      <Button variant="primary">
        Speichern
      </Button>
      <Badge tone="ok">Gespeichert</Badge>
    </ActionBar>
  </div>
)
