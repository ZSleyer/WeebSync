import { Tab, Tabs } from '@weebsync/design-system'

export const Sections = () => (
  <div style={{ maxWidth: 480 }}>
    <Tabs aria-label="Ansicht">
      <Tab selected>Liste</Tab>
      <Tab>Kalender</Tab>
      <Tab>Vorschläge</Tab>
    </Tabs>
  </div>
)
