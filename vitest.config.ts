import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    // `hs project lint` installs its own node_modules inside src/app/cards. Without
    // deduping, the component and the test each load a different copy of React and
    // the SDK, which breaks hooks and component identity.
    dedupe: ['react', 'react-reconciler', '@hubspot/ui-extensions'],
  },
  test: {
    include: ['tests/**/*.test.tsx'],
  },
});
