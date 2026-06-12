import config from 'eslint-config-mourner';

export default [
    ...config,
    {rules: {camelcase: ['error', {properties: 'never'}]}},
];
