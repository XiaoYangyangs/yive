import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    css: { include: /Mobile(?:App|ConversationContent)\.css$/ },
    fileParallelism: false,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.{js,ts,tsx}'],
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    testTimeout: 60_000,
  },
})
