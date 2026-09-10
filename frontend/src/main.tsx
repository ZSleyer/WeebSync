import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router/dom'
import './index.css'
import './locales'
import { router } from './App'
import { ConfirmProvider } from './components/confirm'
import { PromptProvider } from './components/prompt'
import { registerServiceWorker } from './push'
import { applyTheme, readThemePref } from './theme'

registerServiceWorker()

// apply persisted look before first paint
const root = document.documentElement
// orange is the default accent. Violet was, and a stored violet is far more
// likely the old default than a choice, so it becomes orange once. Picking
// violet after that sticks.
let accent = localStorage.getItem('weebsync.accent')
if (accent === 'violet' && !localStorage.getItem('weebsync.accent.v2')) {
  accent = 'orange'
  localStorage.setItem('weebsync.accent', accent)
}
localStorage.setItem('weebsync.accent.v2', '1')
root.dataset.accent = accent ?? 'orange'
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <PromptProvider>
          <RouterProvider router={router} />
        </PromptProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  </StrictMode>,
)
