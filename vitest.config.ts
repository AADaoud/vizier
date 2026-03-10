import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
	},
	resolve: {
		// Stub Obsidian API — not available in test environment
		alias: {
			obsidian: new URL('./src/__mocks__/obsidian.ts', import.meta.url).pathname,
		},
	},
});
