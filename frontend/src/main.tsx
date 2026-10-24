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
import { safeGet } from './hooks/useStored'
import { applyScheme, readScheme } from './scheme'

registerServiceWorker()

// apply persisted look before first paint
const root = document.documentElement
// the colour scheme (an old free accent choice moves over to its scheme once)
applyScheme(readScheme())
applyTheme(readThemePref())
if (safeGet('local', 'weebsync.motion') === 'off') root.dataset.motion = 'off'

// focus rings (see fluid-lycoris.css): the browser's :focus-visible decides,
// so assistive input that sends no keys (voice control, switch access) gets
// its ring too. Only a pointer press switches rings off (data-input=pointer),
// so a click on a field or button stays ring-free; navigation keys - not
// printable ones, so typing into a clicked field stays ring-free - switch
// them back on (data-input=keys, which also carries the custom box-shadow
// rings). Users who asked for forced colours or more contrast always get them.
const NAV_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  ' ',
  'Escape',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'F6',
])
const always = matchMedia('(forced-colors: active), (prefers-contrast: more)')
const setInput = (mode?: 'keys' | 'pointer') => {
  if (always.matches || mode === 'keys') root.dataset.input = 'keys'
  else if (mode) root.dataset.input = mode
  else delete root.dataset.input
}
setInput()
always.addEventListener('change', () => setInput())
// a space typed into a text field is text, not navigation
const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  t.matches('input:not([type=checkbox],[type=radio],[type=button],[type=submit]), textarea, [contenteditable]')
window.addEventListener(
  'keydown',
  (e) => NAV_KEYS.has(e.key) && !(e.key === ' ' && typing(e.target)) && setInput('keys'),
  { capture: true, passive: true },
)
window.addEventListener('pointerdown', () => setInput('pointer'), { capture: true, passive: true })

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
