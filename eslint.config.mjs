import js from '@eslint/js';
export default [
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  { files: ['**/*.js', '**/*.mjs'], ...js.configs.recommended },
];
