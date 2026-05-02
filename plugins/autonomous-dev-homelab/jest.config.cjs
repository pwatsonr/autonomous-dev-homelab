/**
 * Jest config for the autonomous-dev-homelab plugin.
 *
 * Uses CommonJS (.cjs) because package.json sets `"type": "module"`, which
 * would otherwise cause Node to refuse to load this file as ESM. ts-jest
 * itself runs the compiled TS as CJS via the tsconfig's `module: commonjs`.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/tests/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'json-summary'],
};
