import { Button, Dialog } from '@weebsync/design-system'

// Dialog opens as a real modal on mount, so this card shows the native
// <dialog> itself: top layer, backdrop, Escape. One card on purpose - two
// would stack their modals on top of each other.
//
// The dialog element never scrolls itself (a 1px border resolves to 0.667px at
// a device pixel ratio of 3, and the rounding alone produced a phantom
// scrollbar). A modal that can outgrow the screen therefore draws its own
// scroll boundary: `bodyClassName` caps the box, the growing section scrolls.

const entries = Array.from({ length: 12 }, (_, i) => ({
  key: `anilist:21:${1145 + i}`,
  age: `vor ${i + 1} Std`,
}))

export const TallModal = () => (
  <Dialog onClose={() => {}} width="max-w-2xl" aria-label="Cache-Einträge" bodyClassName="dialog-body">
    <header className="border-b border-border-subtle px-5 py-4">
      <h3 className="font-display font-semibold tracking-wider">Cache-Einträge</h3>
    </header>
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
      {entries.map((e) => (
        <p key={e.key} className="flex justify-between gap-4 font-mono text-xs text-t-secondary">
          <span className="truncate">{e.key}</span>
          <span className="shrink-0 text-t-muted">{e.age}</span>
        </p>
      ))}
    </div>
    <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
      <Button size="sm">Schließen</Button>
    </footer>
  </Dialog>
)
