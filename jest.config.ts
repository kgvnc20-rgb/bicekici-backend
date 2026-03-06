import type { Config } from 'jest';

const config: Config = {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: '.',
    testEnvironment: 'node',

    projects: [
        // ─── Unit Tests ───
        {
            displayName: 'unit',
            testMatch: ['<rootDir>/src/**/*.spec.ts'],
            transform: { '^.+\\.ts$': 'ts-jest' },
            moduleFileExtensions: ['js', 'json', 'ts'],
        },
        // ─── E2E Tests ───
        {
            displayName: 'e2e',
            testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
            transform: { '^.+\\.ts$': 'ts-jest' },
            moduleFileExtensions: ['js', 'json', 'ts'],
        },
    ],
};

export default config;
