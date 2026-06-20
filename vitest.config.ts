import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// `obsidian` is only resolvable inside the Obsidian runtime, so unit tests
// alias it to a hand-written stub. Everything else resolves normally.
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
		globals: true,
	},
	resolve: {
		alias: {
			obsidian: resolve(__dirname, 'test/mocks/obsidian.ts'),
		},
	},
});
