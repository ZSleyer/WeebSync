import { Tab, Tabs } from '@weebsync/design-system'

export const States = () => (
  <div style={{ maxWidth: 420 }}>
    <Tabs aria-label="Zustände">
      <Tab selected>Ausgewählt</Tab>
      <Tab>Nicht ausgewählt</Tab>
      <Tab disabled>Gesperrt</Tab>
    </Tabs>
  </div>
)
