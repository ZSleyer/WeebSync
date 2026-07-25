import { Menu, MenuItem } from '@weebsync/design-system'

export const States = () => (
  <div style={{ maxWidth: 260 }}>
    <Menu aria-label="Zustände">
      <MenuItem selected trailing="✓">Ausgewählt</MenuItem>
      <MenuItem>Normal</MenuItem>
    </Menu>
  </div>
)
