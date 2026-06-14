import config from 'eslint-config-mourner';
import e18e from '@e18e/eslint-plugin';

export default [
    ...config,
    e18e.configs.recommended,
    {rules: {camelcase: ['error', {properties: 'never'}]}},
    {files: ['**/test/**'], rules: {'e18e/prefer-static-regex': 'off'}},
];
