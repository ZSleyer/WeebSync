import { createContext, useContext } from 'react'

// The way to the transfers sheet/panel (TransferSheet), on its own so the
// dashboard can open it without importing the sheet, which imports the
// dashboard's speed panel.
export interface Transfers {
  /** opens the transfers; `from` is what they grow out of (the live pill) */
  open: (from?: HTMLElement | null) => void
  /** whether the sheet or panel is up, for the opener's aria-expanded */
  shown: boolean
}

export const TransfersCtx = createContext<Transfers>({ open: () => {}, shown: false })

/** What opens the transfers: the live activity and the dashboard's details. */
export const useTransfers = () => useContext(TransfersCtx)
