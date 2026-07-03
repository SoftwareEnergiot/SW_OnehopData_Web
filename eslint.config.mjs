import next from 'eslint-config-next'

const eslintConfig = [
  ...next,
  {
    ignores: ['node_modules/**', '.next/**', 'out/**', 'build/**'],
  },
  {
    rules: {
      // The decoder deliberately uses `any` at the Buffer/ArrayBuffer boundary.
      '@typescript-eslint/no-explicit-any': 'off',
      // Fetch-on-mount components set a loading flag inside the effect — the
      // idiomatic data-loading pattern used across the dashboard.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]

export default eslintConfig
