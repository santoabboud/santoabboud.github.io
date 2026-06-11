import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
export default defineConfig({
  site: 'https://santoabboud.github.io',
  integrations: [sitemap()],
});
