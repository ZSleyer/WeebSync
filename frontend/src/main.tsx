import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'

// apply persisted look before first paint
const root = document.documentElement
root.dataset.theme = localStorage.getItem('weebsync.theme') ?? 'dark'
root.dataset.accent = localStorage.getItem('weebsync.accent') ?? 'violet'
if (localStorage.getItem('weebsync.motion') === 'off') root.dataset.motion = 'off'

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
