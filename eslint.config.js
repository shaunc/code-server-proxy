const js = require('@eslint/js');
const prettier = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    ignores: ['**/reconnect-helper.js'],
    languageOptions: {
      ecmaVersion: 12,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    plugins: {
      prettier,
    },
    rules: {
      ...prettierConfig.rules,
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^res$' }],
      'prettier/prettier': 'error',
    },
  },
  // Browser environment for client-side scripts
  {
    files: ['**/reconnect-helper.js'],
    languageOptions: {
      ecmaVersion: 12,
      sourceType: 'script',
      globals: {
        console: 'readonly',
        window: 'readonly',
        document: 'readonly',
        Node: 'readonly',
        MutationObserver: 'readonly',
        setTimeout: 'readonly',
      },
    },
    plugins: {
      prettier,
    },
    rules: {
      ...prettierConfig.rules,
      'no-console': 'off',
      'prettier/prettier': 'error',
    },
  },
];
