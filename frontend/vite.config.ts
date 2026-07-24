import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // the design system resolves to its SOURCE, not its dist: no build step
      // before `yarn dev`, and HMR still works while editing a component
      '@weebsync/design-system': fileURLToPath(new URL('../design-system/src/index.ts', import.meta.url)),
    },
  },
  build: {
    // no data:-URI assets - CSP is default-src 'self' without font-src,
    // so inlined fonts get blocked (visible as errors in Firefox devtools)
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
