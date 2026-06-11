import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { SITE } from '../config';

export async function GET(context) {
  const projects = (await getCollection('projects', ({ data }) => !data.draft))
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
  return rss({
    title: SITE.title,
    description: SITE.bio,
    site: context.site,
    items: projects.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.date,
      link: `/projects/${p.id}/`,
    })),
  });
}
