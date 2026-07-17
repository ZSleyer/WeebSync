import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // no data:-URI assets — CSP is default-src 'self' without font-src,
    // so inlined fonts get blocked (visible as errors in Firefox devtools)
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
