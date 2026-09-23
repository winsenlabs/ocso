import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `@/…` is the web app's import alias (apps/web/tsconfig.json paths), for component tests.
  // Public (@winsendotai/*) packages ship no `@ocso/source` condition, so tests reach their src through aliases instead.
  resolve: {
    conditions: ['@ocso/source'],
    alias: [
      { find: /^@\/(.*)$/, replacement: `${import.meta.dirname}/apps/web/$1` },
      { find: /^@winsendotai\/ocso-plugin-sdk$/, replacement: `${import.meta.dirname}/packages/ocso-plugin-sdk/src/index.ts` },
      { find: /^@winsendotai\/ocso-plugin-sdk\/testing$/, replacement: `${import.meta.dirname}/packages/ocso-plugin-sdk/src/testing/index.ts` },
      { find: /^@winsendotai\/ocso-chat$/, replacement: `${import.meta.dirname}/packages/ocso-chat/src/index.ts` },
      { find: /^@winsendotai\/ocso-chat-react$/, replacement: `${import.meta.dirname}/packages/ocso-chat-react/src/index.ts` },
      { find: /^@winsendotai\/ocso-chat-react\/native$/, replacement: `${import.meta.dirname}/packages/ocso-chat-react/src/native/index.ts` },
      // React Native cannot run under Node: the chat-react native tests render against a minimal host-component mock.
      { find: /^react-native$/, replacement: `${import.meta.dirname}/packages/ocso-chat-react/test/helpers/react-native-mock.ts` },
    ],
  },
  ssr: { resolve: { conditions: ['@ocso/source'] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx', 'apps/*/test/unit/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
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
