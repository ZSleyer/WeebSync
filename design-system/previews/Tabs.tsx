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

// Seven buckets in a phone-wide box: one row that scrolls sideways instead
// of wrapping into two or three rows above the content.
export const Scrolling = () => (
  <div style={{ width: 360 }}>
    <Tabs aria-label="Bereich" scroll>
      <Tab selected>Merkliste</Tab>
      <Tab>Empfohlen</Tab>
      <Tab>Trending</Tab>
      <Tab>Upgrades</Tab>
      <Tab>Unvollständig</Tab>
      <Tab>Duplikate</Tab>
      <Tab>Ignoriert</Tab>
    </Tabs>
  </div>
)
