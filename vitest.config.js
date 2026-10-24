import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node by default: the modules must import without any browser global.
    // Files that need a DOM opt in with `// @vitest-environment happy-dom`.
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
})
