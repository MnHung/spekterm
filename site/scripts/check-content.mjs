/**
 * project-website: the content scenarios no other check carries (design D12), read from the built
 * HTML.
 *
 * Structural part — about every page, independent of what the pages say:
 *   canonical URL; language switch targets the counterpart; disclaimer and notices link (also on the
 *   not-found page); release links target the latest release; no released or current version
 *   number; the documentation home exists in both languages; per product (src/product.mjs) — the
 *   header's product link and switch, the header logo, exactly one tab icon, the home-screen icon, the
 *   repository links, the sidebar and previous / next links, the share image and its alt text, and on
 *   spek pages the title suffix and og:site_name (also on the not-found page where it applies); spek's
 *   live demo is served at /spek/demo/ with the pinned SHA-256 (a build step that wrote nothing would
 *   otherwise publish a dead link with every other check green).
 * Content part — about what specific pages say:
 *   both landing pages' required elements (read from the main content without the footer, which holds
 *   the disclaimer, and without the header, which holds the product switch); no forbidden platform
 *   phrase ("Linux only", "Linux and macOS only", "macOS is not supported", a one-platform download
 *   button); no download link on a landing page or documentation home that names one file format alone;
 *   spekterm's platform status on no spek page; every required topic of both products has a page; both
 *   data and network pages name what the spec lists; no page uses frontmatter prev / next (the sidebar
 *   filter recomputes pagination without them).
 *
 * `--structural-only` skips the content part (development convenience while pages are being
 * written; the build gate runs both).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse } from 'node-html-parser'
import { landingOf, otherProduct, PRODUCTS, productOf } from '../src/product.mjs'
import { DEMO_FILE, readPin, sha256Hex } from './add-spek-demo.mjs'
import {
  walk,
  CANONICAL_ORIGIN,
  counterpartOf,
  DIST,
  htmlFileOf,
  localeOf,
  main,
  repoRoot,
  selfTest,
  SITE_ROOT,
  sitemapPages,
  textOf,
  HTML_OPTIONS,
} from './lib.mjs'

const LATEST_RELEASE = 'https://github.com/spekhq/spekterm/releases/latest'
const RELEASES = /^https:\/\/github\.com\/spekhq\/spekterm\/releases(\/|$|\?|#)/

/** Every version the app has been released under, plus the current one in the root package.json. */
export function appVersions(root = repoRoot()) {
  const tags = execFileSync('git', ['tag', '-l', 'v*'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean)
  // A clone without tags (a shallow CI checkout) would make the version check pass silently;
  // `v0.2.1` exists, so an empty list is always an environment problem.
  if (tags.length === 0) throw new Error('git lists no v* tag — fetch tags before building (the version check needs them)')
  const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  return [...new Set([...tags.map((tag) => tag.slice(1)), current])]
}

function versionPattern(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Word boundaries for dotted numbers: "0.2.1" must not match "10.2.1", "0.2.10" or "0.2.1.5".
  return new RegExp(`(?<![0-9A-Za-z.])${escaped}(?![0-9A-Za-z]|\\.[0-9])`)
}

function readStrings(siteDir) {
  return Object.fromEntries(
    ['en', 'zh-TW'].map((lang) => [lang, JSON.parse(readFileSync(join(siteDir, 'src/i18n', `${lang}.json`), 'utf8'))]),
  )
}

/** The page's main content without the footer Starlight renders inside `<main>`. */
function mainContent(root) {
  const main = root.querySelector('main') ?? root
  for (const footer of main.querySelectorAll('.site-footer, footer')) footer.remove()
  return main
}

/**
 * A keyword as a word: `git` must not match inside `spekhq.github.io`. A keyword with spaces (a command)
 * is matched as a substring — a code block's text runs into its neighbours.
 */
function hasWord(text, keyword) {
  if (/\s/.test(keyword)) return text.includes(keyword)
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_.])${escaped}(?![A-Za-z0-9_])`).test(text)
}

const under = (href, base) => href === base || href.startsWith(`${base}/`)

/** Lower case with whitespace runs collapsed, as `textOf` collapses a page's text. */
const normalise = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** The formats among `formats` that `text` names, as words, case-insensitively. */
function formatsNamed(text, formats) {
  return formats.filter((format) => {
    const escaped = format.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(text)
  })
}

/** Content files whose frontmatter sets prev / next. */
function frontmatterPagination(sources) {
  const found = []
  for (const [file, text] of Object.entries(sources)) {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
    if (/^(prev|next):/m.test(frontmatter)) found.push(file)
  }
  return found
}

function readSources(siteDir) {
  const dir = join(siteDir, 'src/content/docs')
  return Object.fromEntries(walk(dir).filter((f) => /\.mdx?$/.test(f)).map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
}

/**
 * @param {string} dist built site
 * @param {{ plan: any, strings: Record<string, Record<string, string>>, versions: string[], sources: Record<string, string>, demoPin: { sha256: string }, structuralOnly?: boolean }} options
 */
export function checkContent(dist, { plan, strings, versions, sources, demoPin, structuralOnly = false }) {
  const problems = []
  const pages = sitemapPages(dist)
  const pageSet = new Set(pages)
  const docs = pages.map((path) => ({ path, file: htmlFileOf(dist, path) }))
  const notFound = join(dist, '404.html')
  const everyDocument = [...docs, ...(existsSync(notFound) ? [{ path: '404.html', file: notFound }] : [])]
  if (!existsSync(notFound)) problems.push('the not-found page (404.html) was not built')

  // --- structural ----------------------------------------------------------------------------
  for (const required of ['/docs/', '/zh-tw/docs/']) {
    if (!pageSet.has(required)) problems.push(`the documentation home ${required} is not in the sitemap`)
  }

  const versionPatterns = versions.map((version) => [version, versionPattern(version)])

  for (const { path, file } of everyDocument) {
    if (!existsSync(file)) {
      problems.push(`${path}: listed in the sitemap but not built`)
      continue
    }
    const html = readFileSync(file, 'utf8')
    const root = parse(html, HTML_OPTIONS)
    const isPage = path !== '404.html'
    const product = isPage ? productOf(path) : 'spekterm'
    const own = PRODUCTS[product]
    const other = PRODUCTS[otherProduct(product)]
    const { lang } = isPage ? localeOf(path) : { lang: 'en' }

    if (isPage) {
      const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute('href')
      if (canonical !== `${CANONICAL_ORIGIN}${path}`) {
        problems.push(`${path}: canonical URL is ${canonical ?? 'missing'}, expected ${CANONICAL_ORIGIN}${path}`)
      }
      const selects = root.querySelectorAll('starlight-lang-select select')
      if (selects.length === 0) problems.push(`${path}: no language switch`)
      const target = counterpartOf(path)
      for (const select of selects) {
        const values = select.querySelectorAll('option').map((option) => option.getAttribute('value'))
        if (!values.includes(target)) problems.push(`${path}: language switch does not offer ${target}`)
      }
    }

    // The header names the page's product and switches to the other (project-website).
    const titleHref = root.querySelector('.product-title a.site-title')?.getAttribute('href')
    if (titleHref !== landingOf(product, lang)) {
      problems.push(`${path}: the header's product link targets ${titleHref ?? 'nothing'}, expected ${landingOf(product, lang)}`)
    }
    const switchHref = root.querySelector('.product-title a.product-switch')?.getAttribute('href')
    if (switchHref !== landingOf(otherProduct(product), lang)) {
      problems.push(`${path}: the header's product switch targets ${switchHref ?? 'nothing'}, expected ${landingOf(otherProduct(product), lang)}`)
    }

    // Brand. A declared icon the build does not contain shows the browser's blank page icon (as it
    // did before the site had one: Starlight declares /favicon.svg whether or not it exists).
    const logo = root.querySelector('.site-title img')?.getAttribute('src')
    if (!logo) problems.push(`${path}: no logo in the header`)
    else if (!basename(logo).startsWith(own.logoPrefix)) problems.push(`${path}: the header logo ${logo} is not ${own.name}'s`)
    const icons = root.querySelectorAll('link[rel~="icon"]').map((link) => link.getAttribute('href'))
    if (icons.length === 0) problems.push(`${path}: declares no tab icon`)
    else if (icons.length > 1) problems.push(`${path}: declares ${icons.length} tab icons (${icons.join(', ')})`)
    else if (icons[0] !== own.favicon) problems.push(`${path}: its tab icon ${icons[0]} is not ${own.name}'s (${own.favicon})`)
    else if (!existsSync(join(dist, icons[0]))) problems.push(`${path}: its tab icon ${icons[0]} is not in the build`)
    const homeIcon = root.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')
    if (homeIcon !== own.homeIcon) problems.push(`${path}: its home-screen icon is ${homeIcon ?? 'missing'}, expected ${own.homeIcon}`)
    else if (!existsSync(join(dist, homeIcon))) problems.push(`${path}: its home-screen icon ${homeIcon} is not in the build`)

    // Repository links in the header (and the mobile menu) and the footer are the product's.
    const repoLinks = root.querySelectorAll('a[rel="me"], .site-footer a').map((a) => a.getAttribute('href') ?? '')
    if (repoLinks.some((href) => under(href, other.repository))) {
      problems.push(`${path}: a header or footer link targets ${other.name}'s repository`)
    }
    if (!root.querySelectorAll('a[rel="me"]').some((a) => a.getAttribute('href') === own.repository)) {
      problems.push(`${path}: the header's repository link is not ${own.repository}`)
    }
    if (!root.querySelector(`.site-footer a[href="${own.repository}"]`) || !root.querySelector(`.site-footer a[href="${own.license}"]`)) {
      problems.push(`${path}: the footer's source and license links are not ${own.name}'s`)
    }

    if (isPage) {
      // Sidebar and previous / next stay within the product.
      // Site pages only: the sidebar also holds the mobile menu's repository link. By class, not by its
      // label — Starlight translates the label ("主要" on Traditional Chinese pages).
      for (const a of root.querySelectorAll('nav.sidebar a[href^="/"]')) {
        const href = a.getAttribute('href')
        if (productOf(href) !== product) problems.push(`${path}: the sidebar links to ${href}, a page of the other product`)
      }
      for (const a of root.querySelectorAll('a[rel="prev"], a[rel="next"]')) {
        const href = a.getAttribute('href')
        if (productOf(href) !== product) problems.push(`${path}: the ${a.getAttribute('rel')} link targets ${href}, a page of the other product`)
      }

      const expected = `${CANONICAL_ORIGIN}${own.share[lang]}`
      for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
        const image = root.querySelector(selector)?.getAttribute('content')
        if (image !== expected) problems.push(`${path}: ${selector} is ${image ?? 'missing'}, expected ${expected}`)
      }
      if (!existsSync(join(dist, own.share[lang]))) problems.push(`${path}: its share image ${own.share[lang]} is not in the build`)
      const alt = root.querySelector('meta[property="og:image:alt"]')?.getAttribute('content')
      if (alt !== strings[lang]?.[own.shareAltKey]) problems.push(`${path}: og:image:alt is ${alt ?? 'missing'}, not ${own.name}'s`)

      if (product === 'spek') {
        const title = root.querySelector('title')?.textContent ?? ''
        if (!/\|\s*spek$/.test(title)) problems.push(`${path}: the title "${title}" does not end with spek`)
        const siteName = root.querySelector('meta[property="og:site_name"]')?.getAttribute('content')
        if (siteName !== 'spek') problems.push(`${path}: og:site_name is ${siteName ?? 'missing'}, expected spek`)
      }
    }

    const disclaimer = root.querySelector('.site-footer .disclaimer')?.textContent ?? ''
    if (!disclaimer.includes('Anthropic') || !disclaimer.includes('OpenSpec')) {
      problems.push(`${path}: the non-affiliation statement is missing`)
    } else if (!hasWord(disclaimer, 'spekterm') || !hasWord(disclaimer, 'spek')) {
      problems.push(`${path}: the non-affiliation statement does not name both spekterm and spek`)
    }
    if (!root.querySelector('a[href="/third-party-notices.txt"]')) {
      problems.push(`${path}: no link to the third-party notices`)
    }
    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href')
      if (RELEASES.test(href) && href !== LATEST_RELEASE) {
        problems.push(`${path}: release link ${href} does not target ${LATEST_RELEASE}`)
      }
    }
    for (const [version, pattern] of versionPatterns) {
      if (pattern.test(html)) problems.push(`${path}: carries the app version ${version}`)
    }
  }

  const demo = join(dist, DEMO_FILE)
  if (!existsSync(demo)) problems.push(`spek's live demo (/${DEMO_FILE}) was not built`)
  else if (sha256Hex(readFileSync(demo)) !== demoPin.sha256) {
    problems.push(`/${DEMO_FILE}: its SHA-256 is not the pin's (${demoPin.sha256})`)
  }

  for (const file of frontmatterPagination(sources)) {
    problems.push(`${file}: sets prev / next in its frontmatter, which the per-product pagination does not honor`)
  }

  if (structuralOnly) return problems

  // --- content -------------------------------------------------------------------------------
  const phrases = plan.forbiddenPhrases.map(normalise)
  for (const { path, file } of everyDocument) {
    if (!existsSync(file)) continue
    const text = textOf(parse(readFileSync(file, 'utf8'), HTML_OPTIONS))
    const lower = normalise(text)
    for (const phrase of phrases) if (lower.includes(phrase)) problems.push(`${path}: says "${phrase}"`)
    if (path !== '404.html' && productOf(path) === 'spek') {
      const platforms = strings[localeOf(path).lang]?.[plan.landing.platformsString]
      if (platforms && text.includes(platforms)) problems.push(`${path}: states spekterm's platform status on a spek page`)
    }
  }

  for (const topic of [...plan.topics, ...plan.spek.topics]) {
    for (const prefix of ['', '/zh-tw']) {
      const path = `${prefix}/${topic}/`
      if (!pageSet.has(path)) problems.push(`required topic page ${path} is missing`)
    }
  }

  const landing = (path) => {
    const file = htmlFileOf(dist, path)
    if (!existsSync(file)) {
      problems.push(`landing page ${path} was not built`)
      return null
    }
    const main = mainContent(parse(readFileSync(file, 'utf8'), HTML_OPTIONS))
    return {
      main,
      links: main.querySelectorAll('a[href]').map((a) => a.getAttribute('href')),
      text: textOf(main),
      images: main.querySelectorAll('img').map((img) => (img.getAttribute('src') ?? '').split('/').pop()),
    }
  }

  // A download call to action does not name one platform's file format as if it were the only download.
  for (const path of ['/', '/zh-tw/', '/docs/', '/zh-tw/docs/']) {
    const file = htmlFileOf(dist, path)
    if (!existsSync(file)) continue // reported above (landing page, documentation home)
    const main = mainContent(parse(readFileSync(file, 'utf8'), HTML_OPTIONS))
    for (const a of main.querySelectorAll('a[href]')) {
      if (!RELEASES.test(a.getAttribute('href'))) continue
      const named = formatsNamed(textOf(a), plan.downloadFormats)
      if (named.length === 1) problems.push(`${path}: the download link "${textOf(a)}" names ${named[0]} as the only download`)
    }
  }

  for (const path of ['/', '/zh-tw/']) {
    const page = landing(path)
    if (!page) continue
    const { lang, prefix } = localeOf(path)
    if (!page.images.some((name) => name.startsWith(`${plan.landing.heroScreenshot}.`))) {
      problems.push(`${path}: no hero screenshot (an image named ${plan.landing.heroScreenshot}.*)`)
    }
    if (!page.links.includes(LATEST_RELEASE)) problems.push(`${path}: no download link to ${LATEST_RELEASE}`)
    if (!page.links.some((href) => href.startsWith(`${prefix}/docs/`))) problems.push(`${path}: no link to the documentation`)
    if (!page.links.some((href) => /^https:\/\/github\.com\/spekhq\/spekterm\/?$/.test(href))) {
      problems.push(`${path}: no link to the source repository`)
    }
    if (!page.links.includes(landingOf('spek', lang))) problems.push(`${path}: no link to spek's landing page`)
    for (const name of ['Claude Code', 'OpenSpec']) if (!page.text.includes(name)) problems.push(`${path}: does not name ${name}`)
    const platforms = strings[lang]?.[plan.landing.platformsString]
    if (!platforms || !page.text.includes(platforms)) problems.push(`${path}: does not state the platform status`)
  }

  for (const path of ['/spek/', '/zh-tw/spek/']) {
    const page = landing(path)
    if (!page) continue
    const { lang, prefix } = localeOf(path)
    if (!page.images.some((name) => name.startsWith(plan.spek.landing.screenshotPrefix))) {
      problems.push(`${path}: no spek screenshot (an image named ${plan.spek.landing.screenshotPrefix}*)`)
    }
    for (const href of plan.spek.landing.links) if (!page.links.includes(href)) problems.push(`${path}: no link to ${href}`)
    if (!page.links.some((href) => href.startsWith(`${prefix}/spek/docs/`))) problems.push(`${path}: no link to spek's documentation`)
    if (!page.links.includes(landingOf('spekterm', lang))) problems.push(`${path}: no link to spekterm's landing page`)
    if (!page.text.includes('OpenSpec')) problems.push(`${path}: does not name OpenSpec`)
  }

  for (const { lang, prefix } of [
    { lang: 'en', prefix: '' },
    { lang: 'zh-TW', prefix: '/zh-tw' },
  ]) {
    for (const [page, keywords, word] of [
      [plan.dataAndNetwork, plan.dataAndNetworkKeywords[lang], false],
      [plan.spek.dataAndNetwork, plan.spek.dataAndNetworkKeywords[lang], true],
    ]) {
      const path = `${prefix}/${page}/`
      const file = htmlFileOf(dist, path)
      if (!existsSync(file)) continue // reported as a missing topic above
      const text = textOf(parse(readFileSync(file, 'utf8'), HTML_OPTIONS))
      for (const keyword of keywords) {
        if (!(word ? hasWord(text, keyword) : text.includes(keyword))) problems.push(`${path}: does not mention "${keyword}"`)
      }
    }
  }

  return problems
}

// ---------------------------------------------------------------------------------------------
// Self-test: a built site that satisfies every rule, and one mutation per rule.

const PLAN = {
  topics: ['docs/a', 'docs/net'],
  dataAndNetwork: 'docs/net',
  landing: { heroScreenshot: 'hero', platformsString: 'landing.platforms' },
  dataAndNetworkKeywords: { en: ['Slack', 'login shell'], 'zh-TW': ['Slack', 'login shell'] },
  forbiddenPhrases: ['Linux only', '只支援 Linux', 'macOS is not supported', '尚未支援 macOS', 'Linux and macOS only', 'Download for Linux (AppImage)'],
  downloadFormats: ['AppImage', 'dmg'],
  spek: {
    topics: ['spek/docs/x', 'spek/docs/net'],
    dataAndNetwork: 'spek/docs/net',
    landing: { screenshotPrefix: 'spek-', links: ['https://github.com/spekhq/spek', '/spek/demo/'] },
    dataAndNetworkKeywords: { en: ['git', '3001'], 'zh-TW': ['git', '3001'] },
  },
}
const STRINGS = {
  en: { 'landing.platforms': 'Builds for Linux and for macOS on Apple Silicon.', 'social.imageAlt': 'spekterm card', 'social.spekImageAlt': 'spek card' },
  'zh-TW': { 'landing.platforms': '目前提供 Linux 與 Apple Silicon 的 macOS 版本。', 'social.imageAlt': 'spekterm 卡片', 'social.spekImageAlt': 'spek 卡片' },
}
const VERSIONS = ['0.2.1', '0.2.2']
const PAGES = [
  '/', '/zh-tw/', '/docs/', '/zh-tw/docs/', '/docs/a/', '/zh-tw/docs/a/', '/docs/net/', '/zh-tw/docs/net/',
  '/spek/', '/zh-tw/spek/', '/spek/docs/', '/zh-tw/spek/docs/', '/spek/docs/x/', '/zh-tw/spek/docs/x/',
  '/spek/docs/net/', '/zh-tw/spek/docs/net/',
]
const DISCLAIMER = 'spekterm and spek are not affiliated with Anthropic or the OpenSpec project.'
const SOURCES = { 'docs/a.md': '---\ntitle: A\n---\n\nText.\n' }

/** A built page as Starlight and the site's overrides render it, for the page's product unless overridden. */
function fakePage(path, options = {}) {
  const pagePath = path === '/404/' ? '/' : path
  const product = productOf(pagePath)
  const own = PRODUCTS[product]
  const lang = pagePath.startsWith('/zh-tw/') ? 'zh-TW' : 'en'
  const {
    canonical,
    switchTo,
    footer = true,
    main = '',
    notices = true,
    icons = [own.favicon],
    homeIcon = own.homeIcon,
    logo = own.logoPrefix,
    share = own.share[lang],
    alt = STRINGS[lang][own.shareAltKey],
    title = `Page | ${own.name}`,
    siteName = own.name,
    titleHref = landingOf(product, lang),
    switchHref = landingOf(otherProduct(product), lang),
    repo = own.repository,
    footerRepo = own.repository,
    license = own.license,
    sidebar = [landingOf(product, lang)],
    pagination = [],
    disclaimer = DISCLAIMER,
  } = options
  const other = switchTo ?? counterpartOf(path)
  const self = path
  const shareUrl = share ? CANONICAL_ORIGIN + share : null
  return `<!doctype html><html><head><title>${title}</title><link rel="canonical" href="${canonical ?? CANONICAL_ORIGIN + path}">${icons.map((icon) => `<link rel="shortcut icon" href="${icon}" type="image/svg+xml">`).join('')}${homeIcon ? `<link rel="apple-touch-icon" href="${homeIcon}">` : ''}${shareUrl ? `<meta property="og:image" content="${shareUrl}"><meta name="twitter:image" content="${shareUrl}">` : ''}<meta property="og:image:alt" content="${alt}"><meta property="og:site_name" content="${siteName}"></head><body>
<header><div class="product-title"><a class="site-title" href="${titleHref}">${logo ? `<img src="/_astro/${logo}Ab12.svg" alt="">` : ''}<span>${own.name}</span></a><a class="product-switch" href="${switchHref}">other</a></div><a href="${repo}" rel="me">GitHub</a></header>
<nav class="sidebar" aria-label="${lang === 'zh-TW' ? '主要' : 'Main'}">${sidebar.map((href) => `<a href="${href}">x</a>`).join('')}</nav>
<starlight-lang-select><select><option value="${path.startsWith('/zh-tw/') ? other : self}">English</option><option value="${path.startsWith('/zh-tw/') ? self : other}">繁體中文</option></select></starlight-lang-select>
<main>${main}${pagination.map(([rel, href]) => `<a href="${href}" rel="${rel}">${rel}</a>`).join('')}
${footer ? `<div class="site-footer"><p class="disclaimer">${disclaimer}</p>` : '<div>'}<p><a href="${footerRepo}">Source</a> <a href="${license}">License</a>${notices ? ' <a href="/third-party-notices.txt">Notices</a>' : ''}</p></div></main>
</body></html>`
}

function landingMain(lang, { hero = true, download = true, platforms = true, spekLink = true } = {}) {
  const prefix = lang === 'en' ? '' : '/zh-tw'
  return `<h1>spekterm</h1><p>Claude Code next to OpenSpec.</p>${platforms ? `<p>${STRINGS[lang]['landing.platforms']}</p>` : ''}
${hero ? '<img src="/_astro/hero.Ab12.webp" alt="">' : ''}${download ? `<a href="${LATEST_RELEASE}">Download</a>` : ''}<a href="${prefix}/docs/">Docs</a><a href="https://github.com/spekhq/spekterm">Source</a>${spekLink ? `<a href="${prefix}/spek/">spek</a>` : ''}`
}

function spekLandingMain(lang, { openspec = true, demo = true, spektermLink = true } = {}) {
  const prefix = lang === 'en' ? '' : '/zh-tw'
  return `<h1>spek</h1><p>${openspec ? 'A viewer for OpenSpec.' : 'A viewer.'}</p><img src="/_astro/spek-change.Ab12.webp" alt="">
<a href="https://github.com/spekhq/spek">Source</a>${demo ? '<a href="/spek/demo/">Demo</a>' : ''}<a href="${prefix}/spek/docs/">Docs</a>${spektermLink ? `<a href="${prefix}/">spekterm</a>` : ''}`
}

/** The demo a fake site serves; the self-test's pin is computed from it, since no fixture can be the real file. */
const DEMO_FIXTURE = '<!doctype html><title>spek demo</title><div id="root"></div>'

function fakeSite(overrides = {}, { omit = [] } = {}) {
  const files = {
    'sitemap-index.xml': `<sitemapindex><sitemap><loc>${CANONICAL_ORIGIN}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
    'sitemap-0.xml': `<urlset>${PAGES.filter((p) => !omit.includes(p))
      .map((p) => `<url><loc>${CANONICAL_ORIGIN}${p}</loc></url>`)
      .join('')}</urlset>`,
    '404.html': fakePage('/404/'),
    [DEMO_FILE]: DEMO_FIXTURE,
  }
  for (const own of Object.values(PRODUCTS)) {
    for (const asset of [own.favicon, own.homeIcon, ...Object.values(own.share)]) files[asset.slice(1)] = 'x'
  }
  for (const path of PAGES) {
    if (omit.includes(path)) continue
    const lang = path.startsWith('/zh-tw/') ? 'zh-TW' : 'en'
    let main = ''
    if (path === '/' || path === '/zh-tw/') main = landingMain(lang)
    if (path === '/spek/' || path === '/zh-tw/spek/') main = spekLandingMain(lang)
    // The login shell sits in a highlighted code block, as Starlight renders one: the check must read
    // a code block's text, not its markup.
    if (path.endsWith('/docs/net/') && !path.includes('/spek/')) {
      main = '<p>Slack.</p><pre data-language="bash"><code><div class="ec-line"><span>The</span><span> </span><span>login</span><span> </span><span>shell</span></div></code></pre>'
    }
    if (path.includes('/spek/docs/net/')) main = '<p>It runs <code>git</code> and listens on port 3001.</p>'
    files[`${path.slice(1)}index.html`] = fakePage(path, { main })
  }
  return { ...files, ...overrides }
}

const withoutFile = (files, name) => Object.fromEntries(Object.entries(files).filter(([key]) => key !== name))

const run = (structuralOnly, sources = SOURCES) => (dir) =>
  checkContent(dir, { plan: PLAN, strings: STRINGS, versions: VERSIONS, sources, demoPin: { sha256: sha256Hex(DEMO_FIXTURE) }, structuralOnly })

function runSelfTest() {
  // The product of a path (design D1), the one function the site and this check share.
  const products = { '/': 'spekterm', '/docs/x/': 'spekterm', '/spek/': 'spek', '/zh-tw/spek/docs/x/': 'spek', '/spekx/': 'spekterm', '/zh-tw/': 'spekterm', '404.html': 'spekterm' }
  const wrong = Object.entries(products).filter(([path, product]) => productOf(path) !== product)
  if (wrong.length > 0) throw new Error(`check-content self-test failed: productOf(${wrong.map(([p]) => p).join(', ')}) is wrong`)

  const spekPage = '/spek/docs/x/'
  selfTest('check-content (structural)', {
    pass: fakeSite(),
    check: run(true),
    cases: [
      { label: 'a wrong canonical URL', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { canonical: 'https://spekterm.pages.dev/docs/a/' }) }), expect: 'canonical URL' },
      { label: 'a language switch to the wrong page', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { switchTo: '/zh-tw/' }) }), expect: 'does not offer /zh-tw/docs/a/' },
      { label: 'a page without the disclaimer', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { footer: false }) }), expect: 'non-affiliation' },
      { label: 'a disclaimer naming only spekterm', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { disclaimer: 'spekterm is not affiliated with Anthropic or the OpenSpec project.' }) }), expect: 'does not name both spekterm and spek' },
      { label: 'the not-found page without the notices link', files: fakeSite({ '404.html': fakePage('/404/', { notices: false }) }), expect: '404.html: no link to the third-party notices' },
      { label: 'a link to a specific release', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { main: '<a href="https://github.com/spekhq/spekterm/releases/tag/v0.2.1">x</a>' }) }), expect: 'does not target' },
      { label: 'a released version on a page', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { main: '<p>Spekterm-0.2.1.AppImage</p>' }) }), expect: 'app version 0.2.1' },
      { label: 'no documentation home', files: fakeSite({}, { omit: ['/zh-tw/docs/'] }), expect: '/zh-tw/docs/ is not in the sitemap' },
      { label: 'a declared tab icon that was not built', files: withoutFile(fakeSite(), 'favicon.svg'), expect: 'tab icon /favicon.svg is not in the build' },
      { label: 'a page with no tab icon', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { icons: [] }) }), expect: '/docs/a/: declares no tab icon' },
      { label: 'a spek page with both tab icons', files: fakeSite({ 'spek/docs/x/index.html': fakePage(spekPage, { icons: ['/favicon.svg', '/spek-favicon.svg'] }) }), expect: 'declares 2 tab icons' },
      { label: "a spek page with spekterm's tab icon", files: fakeSite({ 'spek/docs/x/index.html': fakePage(spekPage, { icons: ['/favicon.svg'] }) }), expect: "is not spek's" },
      { label: 'the not-found page without the logo', files: fakeSite({ '404.html': fakePage('/404/', { logo: null }) }), expect: '404.html: no logo in the header' },
      { label: "a spek page with spekterm's logo", files: fakeSite({ 'spek/docs/x/index.html': fakePage(spekPage, { logo: 'logo.' }) }), expect: "header logo /_astro/logo.Ab12.svg is not spek's" },
      { label: "a spek page with spekterm's home-screen icon", files: fakeSite({ 'spek/docs/x/index.html': fakePage(spekPage, { homeIcon: '/apple-touch-icon.png' }) }), expect: 'home-screen icon is /apple-touch-icon.png' },
      { label: 'a page without a share image', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { share: null }) }), expect: 'meta[property="og:image"] is missing' },
      { label: 'a Chinese page with the English share image', files: fakeSite({ 'zh-tw/docs/a/index.html': fakePage('/zh-tw/docs/a/', { share: '/og/en.png' }) }), expect: 'expected https://spekterm.com/og/zh-tw.png' },
      { label: "a spek page with spekterm's share image", files: fakeSite({ 'spek/docs/x/index.html': fakePage(spekPage, { share: '/og/en.png' }) }), expect: 'expected https://spekterm.com/og/spek-en.png' },
      { label: 'a share image that was not built', files: withoutFile(fakeSite(), 'og/zh-tw.png'), expect: 'share image /og/zh-tw.png is not in the build' },
      { label: "a spek page with spekterm's share alt text", files: fakeSite({ 'spek/docs/x/index.html': fakePage(spekPage, { alt: 'spekterm card' }) }), expect: "og:image:alt is spekterm card, not spek's" },
      { label: "a spek page titled with spekterm's name", files: fakeSite({ 'spek/docs/x/index.html': fakePage(spekPage, { title: 'Page | spekterm' }) }), expect: 'does not end with spek' },
      { label: "a spek page with spekterm's og:site_name", files: fakeSite({ 'spek/docs/x/index.html': fakePage(spekPage, { siteName: 'spekterm' }) }), expect: 'og:site_name is spekterm' },
      { label: 'a header product link to the other product', files: fakeSite({ 'spek/docs/x/index.html': fakePage(spekPage, { titleHref: '/' }) }), expect: "product link targets /, expected /spek/" },
      { label: 'a header switch to the same product', files: fakeSite({ 'zh-tw/docs/a/index.html': fakePage('/zh-tw/docs/a/', { switchHref: '/zh-tw/' }) }), expect: 'product switch targets /zh-tw/, expected /zh-tw/spek/' },
      { label: "a spek page linking spekterm's repository in the header", files: fakeSite({ 'spek/docs/x/index.html': fakePage(spekPage, { repo: 'https://github.com/spekhq/spekterm' }) }), expect: "targets spekterm's repository" },
      { label: "a spekterm page with spek's footer links", files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { footerRepo: 'https://github.com/spekhq/spek', license: 'https://github.com/spekhq/spek/blob/master/LICENSE' }) }), expect: "footer's source and license links are not spekterm's" },
      { label: "a spekterm sidebar listing a spek page", files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { sidebar: ['/docs/net/', '/zh-tw/spek/docs/x/'] }) }), expect: 'sidebar links to /zh-tw/spek/docs/x/' },
      { label: "a Chinese spek sidebar listing a spekterm page", files: fakeSite({ 'zh-tw/spek/docs/x/index.html': fakePage('/zh-tw/spek/docs/x/', { sidebar: ['/zh-tw/docs/a/'] }) }), expect: '/zh-tw/spek/docs/x/: the sidebar links to /zh-tw/docs/a/' },
      { label: 'a next link into the other product', files: fakeSite({ 'docs/net/index.html': fakePage('/docs/net/', { pagination: [['next', '/spek/docs/x/']] }) }), expect: 'the next link targets /spek/docs/x/' },
      { label: 'frontmatter prev / next', files: fakeSite(), sources: { 'docs/a.md': '---\ntitle: A\nnext: false\n---\n' }, expect: 'docs/a.md: sets prev / next' },
    ].map(({ sources, ...rest }) => (sources ? { ...rest, check: run(true, sources) } : rest)),
  })
  // Word boundaries: a longer number that contains a released version is not that version.
  const boundary = run(true)
  const near = fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { main: '<p>10.2.1 and 0.2.10 and 0.2.1.5</p>' }) })
  selfTest('check-content (version boundaries)', { pass: near, check: boundary, cases: [] })

  selfTest('check-content (content)', {
    pass: fakeSite(),
    check: run(false),
    cases: [
      { label: 'a "Linux only" phrase', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { main: '<p>spekterm is LINUX ONLY.</p>' }) }), expect: 'says "linux only"' },
      { label: 'a Chinese "Linux only" phrase', files: fakeSite({ 'zh-tw/docs/a/index.html': fakePage('/zh-tw/docs/a/', { main: '<p>目前只支援 Linux。</p>' }) }), expect: 'says "只支援 linux"' },
      { label: 'a "macOS is not supported" phrase across a line break', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { main: '<p>macOS is not\n  supported yet.</p>' }) }), expect: 'says "macos is not supported"' },
      { label: 'a Chinese "macOS unsupported" phrase', files: fakeSite({ 'zh-tw/docs/a/index.html': fakePage('/zh-tw/docs/a/', { main: '<p>目前尚未支援 macOS。</p>' }) }), expect: 'says "尚未支援 macos"' },
      { label: 'a "Linux and macOS only" phrase', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { main: '<p>spekterm is for Linux and macOS only.</p>' }) }), expect: 'says "linux and macos only"' },
      { label: 'a one-platform download button', files: fakeSite({ 'docs/a/index.html': fakePage('/docs/a/', { main: '<a href="https://github.com/spekhq/spekterm/releases/latest">Download for Linux (AppImage)</a>' }) }), expect: 'says "download for linux (appimage)"' },
      { label: 'a landing download link naming only the dmg', files: fakeSite({ 'index.html': fakePage('/', { main: `${landingMain('en')}<a href="${LATEST_RELEASE}">Get the DMG</a>` }) }), expect: '/: the download link "Get the DMG" names dmg as the only download' },
      { label: 'a documentation-home download link naming only the AppImage', files: fakeSite({ 'zh-tw/docs/index.html': fakePage('/zh-tw/docs/', { main: `<a href="${LATEST_RELEASE}">下載 AppImage</a>` }) }), expect: '/zh-tw/docs/: the download link "下載 AppImage" names AppImage as the only download' },
      { label: "spekterm's platform status on a spek page", files: fakeSite({ 'spek/index.html': fakePage('/spek/', { main: `${spekLandingMain('en')}<p>Builds for Linux and for macOS on Apple Silicon.</p>` }) }), expect: "/spek/: states spekterm's platform status" },
      { label: 'a missing topic', files: fakeSite({}, { omit: ['/zh-tw/docs/a/'] }), expect: '/zh-tw/docs/a/ is missing' },
      { label: 'a missing spek topic', files: fakeSite({}, { omit: ['/spek/docs/x/'] }), expect: '/spek/docs/x/ is missing' },
      { label: 'a landing page without the hero screenshot', files: fakeSite({ 'index.html': fakePage('/', { main: landingMain('en', { hero: false }) }) }), expect: 'no hero screenshot' },
      { label: 'a landing page without the download link', files: fakeSite({ 'zh-tw/index.html': fakePage('/zh-tw/', { main: landingMain('zh-TW', { download: false }) }) }), expect: '/zh-tw/: no download link' },
      { label: 'a landing page without the platform status', files: fakeSite({ 'index.html': fakePage('/', { main: landingMain('en', { platforms: false }) }) }), expect: 'platform status' },
      { label: "a landing page linking spek only from the header", files: fakeSite({ 'index.html': fakePage('/', { main: landingMain('en', { spekLink: false }) }) }), expect: "/: no link to spek's landing page" },
      { label: 'a spek landing page naming OpenSpec only in the footer', files: fakeSite({ 'spek/index.html': fakePage('/spek/', { main: spekLandingMain('en', { openspec: false }) }) }), expect: '/spek/: does not name OpenSpec' },
      { label: 'a spek landing page without the demo link', files: fakeSite({ 'zh-tw/spek/index.html': fakePage('/zh-tw/spek/', { main: spekLandingMain('zh-TW', { demo: false }) }) }), expect: 'no link to /spek/demo/' },
      { label: "a build without spek's live demo", files: withoutFile(fakeSite(), DEMO_FILE), expect: "spek's live demo (/spek/demo/index.html) was not built" },
      { label: 'a demo that is not the pinned file', files: fakeSite({ [DEMO_FILE]: '<!doctype html><p>another release</p>' }), expect: "its SHA-256 is not the pin's" },
      { label: 'a spek landing page linking spekterm only from the header', files: fakeSite({ 'spek/index.html': fakePage('/spek/', { main: spekLandingMain('en', { spektermLink: false }) }) }), expect: "/spek/: no link to spekterm's landing page" },
      { label: 'a data and network page missing a keyword', files: fakeSite({ 'zh-tw/docs/net/index.html': fakePage('/zh-tw/docs/net/', { main: '<p>Slack.</p>' }) }), expect: 'login shell' },
      { label: 'a spek network page whose "git" is only part of a host name', files: fakeSite({ 'spek/docs/net/index.html': fakePage('/spek/docs/net/', { main: '<p>See spekhq.github.io. Port 3001.</p>' }) }), expect: '/spek/docs/net/: does not mention "git"' },
    ],
  })
}

main('check-content', {
  selfTest: runSelfTest,
  run: () =>
    checkContent(DIST, {
      plan: JSON.parse(readFileSync(join(SITE_ROOT, 'src/content-plan.json'), 'utf8')),
      strings: readStrings(SITE_ROOT),
      versions: appVersions(),
      sources: readSources(SITE_ROOT),
      demoPin: readPin(),
      structuralOnly: process.argv.includes('--structural-only'),
    }),
})
