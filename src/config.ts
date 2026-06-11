/** Central site configuration — edit here, not in components. */
export const SITE = {
  title: 'Bilal Abboud',
  url: 'https://santoabboud.github.io',
  bio: 'Multidisciplinary R&D scientist & engineer experienced in lasers, quantum photonics, materials, batteries, and semiconductor/solid-state physics.',
  eyebrow: 'R&D NOTEBOOK · SAN FRANCISCO',
  email: 'santoabboud@gmail.com',
  links: {
    github: 'https://github.com/santoabboud',
    linkedin: 'https://www.linkedin.com/in/bilal-abboud/',
    youtube: 'https://youtube.com/@ebislab',
  },
  /** GoatCounter site code (the MYCODE in https://MYCODE.goatcounter.com).
   *  Empty string disables analytics entirely. Sign up at goatcounter.com,
   *  then set e.g. 'santoabboud'. */
  goatcounter: '',
} as const;

export const CATEGORIES: Record<string, string> = {
  'spectroscopy': 'Spectroscopy',
  'microscopy': 'Microscopy',
  'lasers': 'Lasers',
  'night-vision': 'Night Vision',
  'cameras': 'Cameras',
  'batteries': 'Batteries',
  'art': 'Art',
  'simulation-software': 'Simulation & Software',
};
export const CATEGORY_SLUGS = Object.keys(CATEGORIES) as [string, ...string[]];
