// @ts-check
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightLinksValidator from 'starlight-links-validator'
import { collectNoticeModules, NOTICE_MODULES_FILE } from './scripts/collect-notice-modules.mjs'
import { ANALYTICS_HEAD } from './src/analytics.mjs'

export default defineConfig({
  // Every page declares its canonical URL on this host (project-website: spekterm.com is the
  // canonical host) — including when the hosting provider's own host name serves the same build.
  site: 'https://spekterm.com',
  trailingSlash: 'always',
  vite: { plugins: [collectNoticeModules(NOTICE_MODULES_FILE)] },
  integrations: [
    starlight({
      title: 'spekterm',
      // Per product (src/product.mjs): the header title and switch (SiteTitle), the repository link
      // (SocialIcons), and the icons, share image, site name, sidebar and pagination (routeData.ts).
      routeMiddleware: './src/routeData.ts',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        'zh-tw': { label: '繁體中文', lang: 'zh-TW' },
      },
      // The live check compares served pages with the build byte for byte, so the build must not
      // depend on the environment; `lastUpdated` reads git history, whose depth differs per clone.
      lastUpdated: false,
      // Starlight's own "Built with Starlight" link is replaced by the disclaimer footer.
      credits: false,
      // Google Analytics behind the consent script (src/analytics.mjs); the banner is in the Footer.
      head: ANALYTICS_HEAD,
      customCss: ['./src/styles/theme.css'],
      components: {
        Footer: './src/components/Footer.astro',
        Hero: './src/components/Hero.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        SocialIcons: './src/components/SocialIcons.astro',
      },
      sidebar: [
        {
          label: 'Getting started',
          translations: { 'zh-TW': '開始使用' },
          items: [{ autogenerate: { directory: 'docs/getting-started' } }],
        },
        {
          label: 'Using spekterm',
          translations: { 'zh-TW': '使用 spekterm' },
          items: [{ autogenerate: { directory: 'docs/using' } }],
        },
        {
          label: 'Reference',
          translations: { 'zh-TW': '參考' },
          items: [{ autogenerate: { directory: 'docs/reference' } }],
        },
        {
          label: 'Help',
          translations: { 'zh-TW': '說明' },
          items: [{ autogenerate: { directory: 'docs/help' } }],
        },
        // spek's groups; routeData.ts shows each product only its own.
        {
          label: 'Getting started',
          translations: { 'zh-TW': '開始使用' },
          items: [{ autogenerate: { directory: 'spek/docs/getting-started' } }],
        },
        {
          label: 'Using spek',
          translations: { 'zh-TW': '使用 spek' },
          items: [{ autogenerate: { directory: 'spek/docs/using' } }],
        },
        {
          label: 'Reference',
          translations: { 'zh-TW': '參考' },
          items: [{ autogenerate: { directory: 'spek/docs/reference' } }],
        },
        {
          label: 'Help',
          translations: { 'zh-TW': '說明' },
          items: [{ autogenerate: { directory: 'spek/docs/help' } }],
        },
      ],
      plugins: [
        // Fails the build on a broken link or anchor in Markdown content and in frontmatter hero
        // actions (the landing pages' buttons). Component links (the footer) are not seen by it;
        // check-content covers those. The notices and spek's demo are files written after Starlight's
        // pages, not pages — check-content checks the demo is there.
        starlightLinksValidator({ exclude: ['/third-party-notices.txt', '/spek/demo/'] }),
      ],
    }),
  ],
})
