import libraryConfig from '@repo/eslint-config/library.mjs';

export default [
  // The package lints `src` only (see the lint script); the config files sit
  // outside tsconfig's include, so typed linting can't parse them. Global
  // ignores keep lint-staged (which passes explicit paths) aligned with that.
  { ignores: ['eslint.config.mjs', 'vitest.config.ts'] },
  ...libraryConfig,
  {
    // Mirror context-core: drop the `app/**` ignoreExports pattern for this
    // pure-library package (no app/ dir → eslint-plugin-import throws
    // NoFilesFoundError on a zero-match glob under flat config).
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      'import/no-unused-modules': ['error', { unusedExports: true, ignoreExports: [] }],
    },
  },
];
