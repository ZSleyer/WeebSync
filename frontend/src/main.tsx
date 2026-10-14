import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router/dom'
import { useTranslation } from 'react-i18next'
import { CloseLabelContext } from 'fluid-lycoris'
import './index.css'
import './locales'
import { router } from './App'
import { ApiError } from './api'
import { ToastProvider } from './components/toast'
import { ConfirmProvider } from './components/confirm'
import { registerServiceWorker } from './push'
import { applyTheme, readThemePref } from './theme'
import { applyScheme, readScheme } from './scheme'

registerServiceWorker()

// apply persisted look before first paint
const root = document.documentElement
// the colour scheme (an old free accent choice moves over to its scheme once)
applyScheme(readScheme())
applyTheme(readThemePref())
if (localStorage.getItem('weebsync.motion') === 'off') root.dataset.motion = 'off'

// keyboard-modality tracking (what-input pattern): focus rings appear only
// after keyboard navigation and disappear again on pointer use, so a
// programmatic .focus() (e.g. wizard step headings) never paints a ring for
// mouse users - :focus-visible alone shows it before any interaction
window.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' || e.key === 'Enter') root.classList.add('kbd')
})
window.addEventListener('pointerdown', () => root.classList.remove('kbd'))

// the design system's icon-only close buttons speak the UI language
function CloseLabel({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const label = t('common.close')
  return <CloseLabelContext.Provider value={label}>{children}</CloseLabelContext.Provider>
}

// A session that ended elsewhere (logout in another tab, expiry) shows up as
// the 401 of whatever this tab asks next. The user query is what decides
// between login screen and app, so it learns of it there: before, the shell
// stayed up with "unauthorized" in its sections until a reload.
const signedOut = (e: unknown) => {
  if (e instanceof ApiError && e.status === 401) queryClient.setQueryData(['me'], null)
  // the account was put on hold from another device (a sign-in with a
  // password or passkey that has to be replaced): the user query decides
  // that too, so it has to learn of it
  if (e instanceof ApiError && e.status === 403 && (e.data as { upgrade?: string } | undefined)?.upgrade)
    void queryClient.invalidateQueries({ queryKey: ['me'] })
}
const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
  queryCache: new QueryCache({ onError: signedOut }),
  mutationCache: new MutationCache({ onError: signedOut }),
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <ToastProvider>
          <CloseLabel>
            <RouterProvider router={router} />
          </CloseLabel>
        </ToastProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  </StrictMode>,
)
