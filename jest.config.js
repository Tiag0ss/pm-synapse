/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__', '<rootDir>/server', '<rootDir>/lib'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: [
    'server/services/markdown.ts',
    'server/services/notePaths.ts',
    'server/health.ts',
    'lib/renderMarkdown.ts',
    'lib/notePaths.ts',
    '!**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // marked is ESM-only; UMD works under Jest/CJS.
    '^marked$': '<rootDir>/node_modules/marked/lib/marked.umd.js',
  },
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
};
