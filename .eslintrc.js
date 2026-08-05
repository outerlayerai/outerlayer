// Minimal root config required by eslint-plugin-import's no-unused-modules rule
// when using flat config (see https://github.com/import-js/eslint-plugin-import/issues/3079).
// All workspaces use root: true or flat config — this file is NOT used for actual linting.
/** @type {import("eslint").Linter.Config} */
module.exports = {};
