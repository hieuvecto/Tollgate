import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const restrictedSyntax = [
  {
    selector: 'PrivateIdentifier',
    message: 'Use TypeScript private members, not #private fields.',
  },
  {
    selector: 'TSEnumDeclaration[const=true]',
    message: 'Use plain enums, not const enums.',
  },
  {
    selector: 'TSParameterProperty[accessibility=public][readonly=true]',
    message: 'Omit redundant public on readonly parameter properties.',
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'eslint.config.mjs', 'tests/load/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/array-type': [
        'error',
        { default: 'array-simple', readonly: 'array-simple' },
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-check': false, 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'typeParameter', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['UPPER_CASE'] },
        {
          selector: 'variable',
          modifiers: ['const'],
          format: ['camelCase', 'UPPER_CASE'],
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid',
        },
        {
          selector: ['variable', 'function', 'parameter'],
          format: ['camelCase'],
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid',
        },
      ],
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-extraneous-class': 'error',
      '@typescript-eslint/no-namespace': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-wrapper-object-types': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/require-await': 'off',
      curly: ['error', 'multi-line'],
      'default-case': 'error',
      'default-case-last': 'error',
      eqeqeq: ['error', 'always'],
      'new-cap': ['error', { capIsNewExceptions: ['Fastify'] }],
      'no-array-constructor': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-extend-native': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntax,
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports unless a tool requires a default export.',
        },
      ],
      'one-var': ['error', 'never'],
    },
  },
  {
    files: ['vitest.config.ts'],
    rules: { 'no-restricted-syntax': ['error', ...restrictedSyntax] },
  },
);
