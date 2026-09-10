import { Button, Menu, MenuItem, useMenu } from '@weebsync/design-system'

export const SortPicker = () => (
  <div style={{ maxWidth: 260 }}>
    <Menu aria-label="Sortieren nach">
      <MenuItem selected trailing="✓">Nächste Folge</MenuItem>
      <MenuItem>Zuletzt geprüft</MenuItem>
      <MenuItem>Name</MenuItem>
      <MenuItem>Staffel</MenuItem>
    </Menu>
  </div>
)

/**
 * The whole dropdown: useMenu holds the open state and closes on a click
 * outside, on Escape or when the page scrolls. Its ref and anchor go on the
 * wrapper that counts as "inside", so trigger and list are one unit; the list
 * opens in the top layer, hanging from the wrapper's chosen corner.
 */
export const Dropdown = () => {
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  return (
    <div ref={ref} className="relative" style={{ ...anchorStyle, maxWidth: 260 }}>
      <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        Sortieren
      </Button>
      {open && (
        <Menu aria-label="Sortieren nach" anchor={anchor}>
          <MenuItem selected trailing="✓" onClick={() => setOpen(false)}>Nächste Folge</MenuItem>
          <MenuItem onClick={() => setOpen(false)}>Zuletzt geprüft</MenuItem>
          <MenuItem onClick={() => setOpen(false)}>Name</MenuItem>
        </Menu>
      )}
    </div>
  )
}

/**
 * Why the anchor exists: the wrapper sits in a box that clips its overflow,
 * the way a catalog tile or a scrolling panel does. The list still shows in
 * full, and near the right edge it flips to hang from the other corner.
 */
export const InsideClip = () => {
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  return (
    <div className="t-panel" style={{ overflow: 'clip', width: 200, height: 56, padding: 8, display: 'flex', justifyContent: 'flex-end' }}>
      <div ref={ref} className="relative" style={anchorStyle}>
        <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          …
        </Button>
        {open && (
          <Menu aria-label="Aktionen" anchor={anchor} placement="bottom-end">
            <MenuItem onClick={() => setOpen(false)}>Alle neu zuordnen</MenuItem>
            <MenuItem onClick={() => setOpen(false)}>Markierung aufheben</MenuItem>
          </Menu>
        )}
      </div>
    </div>
  )
}
