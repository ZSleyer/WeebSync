import { AppBar, AppShell, Button, NavItem, Panel, TabBar } from '@weebsync/design-system'

// A phone-sized frame around the shell: the point of the component is that the
// bars are rows of a box exactly one viewport tall, so it only shows anything
// when it has a viewport to fill.
export const PhoneShell = () => (
  <div style={{ width: 380, height: 640, overflow: 'hidden', resize: 'both' }}>
    <AppShell
      bar={
        <AppBar>
          <h1 className="font-display text-base font-bold tracking-[0.2em] text-t-primary">
            WEEB<span className="text-accent">SYNC</span>
          </h1>
          <Button size="sm">Abmelden</Button>
        </AppBar>
      }
      tabs={
        <TabBar aria-label="Hauptnavigation">
          <div className="flex">
            <NavItem variant="bottomTab" active href="#">
              Dashboard
            </NavItem>
            <NavItem variant="bottomTab" href="#">
              Lokal
            </NavItem>
            <NavItem variant="bottomTab" href="#">
              Remote
            </NavItem>
          </div>
        </TabBar>
      }
    >
      <Panel className="p-4">Seiteninhalt - scrollt, die Leisten bleiben stehen.</Panel>
    </AppShell>
  </div>
)
