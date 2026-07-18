import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import PromptModal, { type PromptOptions } from './PromptModal'

type PromptFn = (opts: PromptOptions) => Promise<string | null>

const PromptCtx = createContext<PromptFn>(() => Promise.resolve(null))

// App-wide prompt(): `const name = await prompt({ title, defaultValue })` — the
// custom-modal replacement for window.prompt(). One at a time.
export function PromptProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ opts: PromptOptions; resolve: (v: string | null) => void } | null>(null)
  const prompt = useCallback<PromptFn>(
    (opts) =>
      new Promise((resolve) =>
        setState((prev) => {
          prev?.resolve(null)
          return { opts, resolve }
        }),
      ),
    [],
  )
  const settle = (v: string | null) => {
    state?.resolve(v)
    setState(null)
  }
  return (
    <PromptCtx.Provider value={prompt}>
      {children}
      {state && <PromptModal {...state.opts} onSubmit={(v) => settle(v)} onCancel={() => settle(null)} />}
    </PromptCtx.Provider>
  )
}

export const usePrompt = () => useContext(PromptCtx)
