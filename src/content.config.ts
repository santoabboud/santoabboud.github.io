import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { CATEGORY_SLUGS } from './config';

const projects = defineCollection({
  loader: glob({
    pattern: '**/index.md',
    base: './src/content/projects',
    generateId: ({ entry }) => entry.replace(/\/index\.md$/, ''),
  }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      category: z.enum(CATEGORY_SLUGS),
      /** NOTE: dates currently = migration date placeholders; backfill real ones. */
      date: z.coerce.date(),
      cover: image().optional(),
      coverAlt: z.string().optional(),
      draft: z.boolean().default(false),
    }),
});

export const collections = { projects };
