import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './locales'
import App from './App'
import { registerServiceWorker } from './push'

registerServiceWorker()

// apply persisted look before first paint
const root = document.documentElement
root.dataset.theme = localStorage.getItem('weebsync.theme') ?? 'dark'
root.dataset.accent = localStorage.getItem('weebsync.accent') ?? 'violet'
if (localStorage.getItem('weebsync.motion') === 'off') root.dataset.motion = 'off'

// keyboard-modality tracking (what-input pattern): focus rings appear only
// after keyboard navigation and disappear again on pointer use, so a
// programmatic .focus() (e.g. wizard step headings) never paints a ring for
// mouse users — :focus-visible alone shows it before any interaction
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
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
