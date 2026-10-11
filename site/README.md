# spekterm.com

The website of two products: spekterm (`/`, `/docs/`) and spek, the read-only OpenSpec viewer spekterm's
side panel is built on (`/spek/`, `/spek/docs/`) — each with a landing page and user documentation, in
English and Traditional Chinese (`/zh-tw/…`). Built with Astro and Starlight; a self-contained package —
nothing here reaches the desktop app (`openspec/specs/project-website`).

What belongs to one product — the header title and switch, logo, icons, share image, page-title suffix,
repository links, sidebar, previous / next, platform status — follows the page's product: `src/product.mjs`
(shared with `scripts/check-content.mjs`), `src/routeData.ts`, and the `SiteTitle`, `SocialIcons`, `Hero`,
and `Footer` overrides.

## Develop

```bash
cd site
nvm use            # the repository's Node version
npm ci
npm run dev        # http://localhost:4321
```

Pages live in `src/content/docs/` (English) and `src/content/docs/zh-tw/` (Traditional Chinese). **Every
page, every string in `src/i18n/*.json`, and every screenshot must exist in both languages** — the build
fails otherwise. The documentation pages the site must have are listed in `src/content-plan.json`.

## Brand images

The header logo, the tab icon, the home-screen icon, and the share preview of each language are all
derived from the app's icon (`build/icon.svg`); the share preview's title is the landing page's
`hero.title`. They are committed — regenerate them after either changes, and review them before
committing (text goes through the installed fonts):

```bash
node scripts/make-brand-images.mjs
```

spek's marks in `src/assets/spek/` are copied from spek's `logo/` at **v1.19.0**.

spek's live demo, served at `/spek/demo/`, is not in this repository: the build's `spek demo` step fetches
`docs/demo.html` at the tag pinned in `src/spek-demo.json` (**v1.20.2**) from `raw.githubusercontent.com`,
refuses it unless its SHA-256 is the pinned one, and writes it unchanged. It is a file the site serves, not a
page: no site header, one language, not in the sitemap or search, no analytics. The demo carries the notices
of the third-party code it bundles; `third-party-notices.txt` points to them. To move the pin:

```bash
curl -sL https://raw.githubusercontent.com/spekhq/spek/<tag>/docs/demo.html | sha256sum
```

The screenshots come from the repository root's `npm run capture:screenshots` (see the root `CLAUDE.md`).
spek's three screenshots (`src/assets/screenshots/neutral/`, language-neutral: spek's interface has one
language) need a spek checkout in `SPEK_DIR` (default `../spek`) that is clean, at a
`v<major>.<minor>.<patch>` tag, and has run `npm ci`; the capture rebuilds spek's core and ui there (git-ignored
output), runs spek's static-page builder against the fixture repository (it writes and removes
`packages/web/dist-demo` in the checkout); a tag before v1.20.1 also needs network access for spek's font. The tag it used is in
`neutral/SOURCE`. A clean clone at the tag keeps a spek working tree with changes in progress out of it:

```bash
git clone --branch v1.19.0 ../spek /tmp/spek-release && (cd /tmp/spek-release && npm ci)
SPEK_DIR=/tmp/spek-release npm run capture:screenshots
```

## When spek releases

spek's pages describe spek's code, not its README, and nothing in this repository can see that code. On a
spek release: read its changes against `/spek/` and `/spek/docs/` (both languages) — forms, settings,
what it runs and connects to — recapture the spek screenshots from the new tag, update the tag above, and
move the demo pin (`src/spek-demo.json`) to the new tag.

## Build — the gate to publishing

```bash
npm run build            # what the hosting runs; a failure here means nothing is published
npm run build:structure  # same, minus check-content's content part (while pages are being written)
```

The build needs network access: the `spek demo` step fetches spek's demo from GitHub.

`scripts/build.mjs` runs, in order, stopping at the first failure:

| step | what fails it |
|---|---|
| `astro check` | a type error in the site |
| root content guards | an internal name or a maintainer home path anywhere in the repository; restrictive license wording (`../scripts/public-hygiene.test.mjs`, `../scripts/license.test.mjs` — they need git and the whole repository) |
| `astro build` | a broken link or anchor in Markdown content or a hero action (`starlight-links-validator`) |
| `spek demo` | spek's demo cannot be fetched at the pinned tag, its SHA-256 is not the pin's, the content-hygiene matcher finds something in it, it references analytics, it carries no third-party notices, or its embedded content holds a remote Markdown image (`scripts/add-spek-demo.mjs`) |
| `check-parity` | a page, string, or screenshot in one language only |
| `check-origins` | anything loaded from another origin (scripts, styles, fonts, images, frames — including inline styles) — the Google tag included: the consent script in `src/analytics.mjs` adds it at run time, after consent where required |
| `write-notices` | the third-party notices cannot be generated, or omit a package known to ship |
| `check-content` | spek's demo missing or not the pinned file, canonical URLs, language switches, the disclaimer and notices link, the tab icon, header logo and share image (each page's own language), release links, version numbers (needs git tags), the landing page's required content, required topics, the data and network page |

Every check runs its own `--self-test` first (fixtures built to violate it), so a check that has gone
blind stops the build instead of passing it.

## After a deploy

```bash
node scripts/check-live.mjs --commit <deployed commit>
```

Builds that commit in a temporary worktree and checks that https://spekterm.com serves it — every page,
the notices, spek's demo, the not-found response — byte for byte
with no cookie, and that the redirecting hosts keep the path. See `DEPLOY.md` for the hosting setup.
