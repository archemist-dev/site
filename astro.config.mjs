// @ts-check

import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://archemist.dev',
	integrations: [sitemap()],
	markdown: {
		shikiConfig: { theme: 'github-dark-default' },
	},
	fonts: [
		{
			provider: fontProviders.google(),
			name: 'Inter',
			cssVariable: '--font-inter',
			weights: [400, 600, 700, 800],
			fallbacks: ['system-ui', 'sans-serif'],
		},
		{
			provider: fontProviders.google(),
			name: 'JetBrains Mono',
			cssVariable: '--font-mono',
			weights: [400, 500, 700],
			fallbacks: ['ui-monospace', 'monospace'],
		},
	],
});
