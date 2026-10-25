import type { Plugin } from 'vite'

/** The Vite plugin of licenses.mjs: writes the bundle's packages when WEEBSYNC_LICENSES_NPM is set. */
export function licenseInventory(): Plugin
