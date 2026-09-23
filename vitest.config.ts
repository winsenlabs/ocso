import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `@/…` is the web app's import alias (apps/web/tsconfig.json paths), for component tests.
  resolve: { conditions: ['@ocso/source'], alias: [{ find: /^@\/(.*)$/, replacement: `${import.meta.dirname}/apps/web/$1` }] },
  ssr: { resolve: { conditions: ['@ocso/source'] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts', 'apps/*/test/**/*.int.test.ts'],
          pool: 'forks',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
