import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// One folder per article: src/content/articles/<slug>/index.md plus its images.
// Written by `npm run sync`, not by hand.
const articles = defineCollection({
	loader: glob({
		base: './src/content/articles',
		pattern: '*/index.md',
		generateId: ({ entry }) => entry.split('/')[0],
	}),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			pubDate: z.coerce.date(),
			pillar: z.string(),
			cover: image(),
			coverAlt: z.string(),
			linkedin: z.string().url().optional(),
			labs: z.string().url().optional(),
			// YouTube video id of the topic's long video, embedded under the title.
			video: z.string().regex(/^[\w-]{11}$/).optional(),
			// Drafts show in `npm run dev` only, never in the built site.
			draft: z.boolean().default(false),
		}),
});

export const collections = { articles };
