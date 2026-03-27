import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Redirect 'pai' to the source repo so vi.mock('../../../pai/src/lib/config.js') etc. work
      'pai': resolve(__dirname, '../pai/src/index.ts'),
      'thread': resolve(__dirname, '../thread/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    watch: false,
    testTimeout: 10000,
    fileParallelism: false,
    include: ['vitest/**/*.test.ts'],
    exclude: ['vitest/**/*-manual.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'node_modules/', 'dist/'],
    },
  },
})
