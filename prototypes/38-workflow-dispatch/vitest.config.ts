import { defineConfig } from 'vitest/config';
import { workflow } from '@workflow/vitest';

export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ['scenarios/*.scenario.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
