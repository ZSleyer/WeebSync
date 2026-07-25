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
 * outside or on Escape. Its ref goes on the wrapper that counts as "inside",
 * so trigger and list are one unit. Click the button to open it.
 */
export const Dropdown = () => {
  const { open, setOpen, ref } = useMenu()
  return (
    <div ref={ref} className="relative" style={{ maxWidth: 260 }}>
      <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        Sortieren
      </Button>
      {open && (
        <Menu aria-label="Sortieren nach" className="absolute left-0 z-20 mt-1">
          <MenuItem selected trailing="✓" onClick={() => setOpen(false)}>Nächste Folge</MenuItem>
          <MenuItem onClick={() => setOpen(false)}>Zuletzt geprüft</MenuItem>
          <MenuItem onClick={() => setOpen(false)}>Name</MenuItem>
        </Menu>
      )}
    </div>
  )
}
