import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  format: ['esm', 'cjs'],
  minify: false,
  target: 'es2019',
  noExternal: [
    '@mui/x-date-pickers',
    '@mui/x-data-grid',
    '@mui/material',
  ],
});