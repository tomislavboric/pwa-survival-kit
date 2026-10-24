import { defineConfig } from 'vite'

// The demo lives in demo/ and is published to GitHub Pages under the repo path.
export default defineConfig({
  root: 'demo',
  base: '/pwa-survival-kit/',
  build: {
    outDir: '../demo-dist',
    emptyOutDir: true,
  },
})
