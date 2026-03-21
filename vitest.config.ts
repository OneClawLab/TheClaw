import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    watch: false,
    testTimeout: 10000,
    fileParallelism: false,
    include: ['vitest/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'node_modules/', 'dist/'],
    },
  },
})
