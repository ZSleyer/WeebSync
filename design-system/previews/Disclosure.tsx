import { Disclosure, Panel } from '@weebsync/design-system'

// A group heading that folds its block, and the chip-sized variant for a
// sub-group inside it. Native details: Enter and Space toggle, no script.
export const Groups = () => (
  <div style={{ maxWidth: 420 }}>
    <Disclosure title="Geplant" count={36}>
      <Disclosure title="Animeserien" count={36} small>
        <Panel className="p-3 text-sm">Air (2005)</Panel>
      </Disclosure>
    </Disclosure>
    <Disclosure title="Abgeschlossen" count={12} defaultOpen={false}>
      <Panel className="p-3 text-sm">geschlossen</Panel>
    </Disclosure>
  </div>
)
