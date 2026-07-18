import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import ConfirmModal, { type ConfirmOptions } from './ConfirmModal'

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmCtx = createContext<ConfirmFn>(() => Promise.resolve(false))

// App-wide confirm(): mount <ConfirmProvider> once, then `const ok = await
// confirm({ message, destructive })` anywhere — replaces window.confirm() with
// the custom modal. One modal instance at a time (confirms don't stack).
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null)
  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise((resolve) => setState({ opts, resolve })),
    [],
  )
  const settle = (ok: boolean) => {
    state?.resolve(ok)
    setState(null)
  }
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && <ConfirmModal {...state.opts} onConfirm={() => settle(true)} onCancel={() => settle(false)} />}
    </ConfirmCtx.Provider>
  )
}

export const useConfirm = () => useContext(ConfirmCtx)
