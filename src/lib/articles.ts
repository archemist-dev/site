import { getCollection } from 'astro:content';

/** Published articles, newest first. Drafts appear only in `npm run dev`. */
export async function getArticles() {
	const articles = await getCollection('articles', ({ data }) => import.meta.env.DEV || !data.draft);
	return articles.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export function readingMinutes(body = '') {
	return Math.max(1, Math.round(body.split(/\s+/).length / 230));
}
