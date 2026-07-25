import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Test-only config, kept apart from vite.config.ts: a jsdom unit test needs
// neither the Tailwind plugin (no stylesheet is asserted on, only class names)
// nor the dev proxy. What it does share is the design-system alias, so the
// tests import the DS by package name exactly like the app does.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@weebsync/design-system': fileURLToPath(new URL('../design-system/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
