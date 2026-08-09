import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Resolve the `@/` path alias (tsconfig `@/* -> src/*`) so the pure mock-draft
// engine modules can be imported in tests exactly as the app imports them.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
