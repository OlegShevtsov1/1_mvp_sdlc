import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    // tests/ runs the shell scripts against fake commands and git fixtures, hundreds of processes
    // in parallel; on a busy self-hosted runner a single case can take longer than the 5 s default.
    testTimeout: 30_000,
  },
})
