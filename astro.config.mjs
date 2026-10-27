// @ts-check

import { readdirSync, readFileSync } from 'node:fs';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';

// Article publish dates for the sitemap's lastmod, read from each article's frontmatter.
const pubDates = Object.fromEntries(
	readdirSync('./src/content/articles').map((slug) => {
		const md = readFileSync(`./src/content/articles/${slug}/index.md`, 'utf8');
		return [slug, md.match(/^pubDate: "?([\d-]+)"?$/m)?.[1]];
	}),
);
const latest = Object.values(pubDates).filter(Boolean).sort().at(-1);

// https://astro.build/config
export default defineConfig({
	site: 'https://archemist.dev',
	integrations: [
		sitemap({
			serialize(item) {
				const slug = item.url.match(/\/articles\/([^/]+)\/$/)?.[1];
				const date = slug ? pubDates[slug] : latest;
				if (date) item.lastmod = new Date(date).toISOString();
				return item;
			},
		}),
	],
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
			name: 'Source Serif 4',
			cssVariable: '--font-serif',
			weights: [400, 600],
			styles: ['normal', 'italic'],
			fallbacks: ['Georgia', 'serif'],
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
