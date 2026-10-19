// Runs after `astro build`: article diagrams get absolute URLs, so Medium's
// "Import a story" can fetch them. `astro dev` keeps them relative.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = 'https://archemist.dev';
const DIST = join(import.meta.dirname, '..', 'dist', 'articles');

for (const slug of readdirSync(DIST, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
	const page = join(DIST, slug.name, 'index.html');
	const html = readFileSync(page, 'utf8');
	writeFileSync(page, html.replaceAll('src="/articles/', `src="${SITE}/articles/`));
}
