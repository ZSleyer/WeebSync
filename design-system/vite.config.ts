import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Library build off the app's own toolchain (frontend/node_modules); react and
// its jsx runtime stay external so the host provides a single copy.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime'] },
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
  },
})
