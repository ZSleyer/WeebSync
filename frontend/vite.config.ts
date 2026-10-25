import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { licenseInventory } from './scripts/licenses.mjs'

// The fonts the first screen sets its text in, Latin subset: the display face
// of every heading and the body text. Preloaded from the HTML, so they load
// beside the scripts instead of after the stylesheet has been parsed - most
// first visits then paint with them and never swap at all. The names carry a
// build hash, so they are read from the bundle and stay under /assets with
// its long cache.
const CRITICAL_FONTS = [/^chakra-petch-latin-600-normal-.*\.woff2$/, /^ibm-plex-sans-latin-400-normal-.*\.woff2$/]

function preloadFonts(): Plugin {
  return {
    name: 'preload-critical-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) =>
          CRITICAL_FONTS.some((re) => re.test(f.split('/').pop() ?? '')),
        )
        if (files.length !== CRITICAL_FONTS.length)
          throw new Error(`preload-critical-fonts: expected ${CRITICAL_FONTS.length} fonts, found ${files.join(', ')}`)
        return files.map((f) => ({
          tag: 'link',
          attrs: { rel: 'preload', href: `/${f}`, as: 'font', type: 'font/woff2', crossorigin: '' },
          injectTo: 'head' as const,
        }))
      },
    },
  }
}

export default defineConfig({
  // licenseInventory lists the packages of the bundle for the About page,
  // only when tools/licenses/generate.sh asks for it
  plugins: [react(), tailwindcss(), preloadFonts(), licenseInventory()],
  resolve: {
    alias: {
      // the design system resolves to its SOURCE, not its dist: no build step
      // before `yarn dev`, and HMR still works while editing a component
      'fluid-lycoris': fileURLToPath(new URL('../design-system/src/index.ts', import.meta.url)),
    },
  },
  build: {
    // no data:-URI assets - CSP is default-src 'self' without font-src,
    // so inlined fonts get blocked (visible as errors in Firefox devtools)
    assetsInlineLimit: 0,
  },
  // jassub finds its worker and wasm next to itself (new URL(..., import.meta.url));
  // the dev prebundler moves the module away from them
  optimizeDeps: { exclude: ['jassub'] },
  server: {
    proxy: {
      // a second instance for testing runs elsewhere: WEEBSYNC_API=http://localhost:8090 yarn dev
      '/api': process.env.WEEBSYNC_API ?? 'http://localhost:8080',
    },
  },
})
