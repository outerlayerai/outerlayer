import libraryConfig from '@repo/eslint-config/library.mjs';

export default [
  // The package lints `src` only (see the lint script); the config files sit
  // outside tsconfig's include, so typed linting can't parse them. Global
  // ignores keep lint-staged (which passes explicit paths) aligned with that.
  { ignores: ['eslint.config.mjs', 'vitest.config.ts'] },
  ...libraryConfig,
  {
    // Same file scope as library.mjs: an UNSCOPED override would also apply
    // this rule to files the shared config never attaches the import plugin
    // to (e.g. this eslint.config.mjs itself — `**/*.js` doesn't match .mjs),
    // which hard-errors when lint-staged hands eslint explicit filenames.
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    // library.mjs's `import/no-unused-modules` sets `ignoreExports: ['**/app/**']`
    // for dashboard-shaped packages with a Next.js `app/` router. eslint-plugin-import
    // 2.32.0's ignoreExports glob resolution isn't ESLint-9-flat-config-clean: when the
    // pattern matches zero files (true here — this package has no `app/` dir) it hard-throws
    // NoFilesFoundError instead of treating "nothing to ignore" as a no-op. Drop the pattern
    // for this pure-library package rather than patch the shared config.
    rules: {
      'import/no-unused-modules': ['error', { unusedExports: true, ignoreExports: [] }],
    },
  },
];
