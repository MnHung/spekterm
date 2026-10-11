## Why

spek's landing page sends readers to a live demo on another host, `spekhq.github.io/spek/demo.html` —
the one part of spek's web presence the site does not serve. The maintainer wants it on spekterm.com,
beside the user guide.

Until spek 1.20.2 the demo could not live here: it loaded its font from Google Fonts, which this site's
build refuses, and it embedded the absolute checkout path of the machine that built it, which this
repository does not publish. spek 1.20.1 (2026-10-11) embeds its font and carries repository-relative
paths, and its build refuses both regressions; spek 1.20.2 (2026-10-12) adds the third-party notices of the
code the demo bundles, which this site's notices requirement needs.

The same release makes one statement of the site false today: spek's *Data and network* page says the
static pages (the live demo and the GitHub Action's output) load their font from Google Fonts. They no
longer do — the Action's output since that change reached spek's default branch, which the Action builds
by default.

## What Changes

- **The demo is served at `/spek/demo/`**, the page of one spek release, unchanged. The build fetches
  that release's `docs/demo.html` from spek's repository at its tag, refuses it unless its SHA-256 matches
  the pinned value, and refuses it if the repository's content-hygiene matcher finds the maintainer's
  home path or an internal word in it, or if it references analytics or embeds a remote Markdown image. The pin (tag and hash) lives in `site/src/spek-demo.json`; moving
  it is part of the existing "When spek releases" routine.
- **The demo is a file the site serves, not a page of the site**, like the third-party notices: no
  site header, no second language, no share image, not in the sitemap or search — it is spek's app, and
  it stays byte for byte what spek released. It carries **no analytics and no consent question**: it is
  never given the consent script, and the build refuses a demo that references the analytics tag, its
  measurement ID or the consent key; the origins check reads its elements like any built file.
- **The live check compares it** byte for byte with the build, like every page and the notices.
- **spek's landing page links to it** (both languages; the demo itself is English, as spek's interface
  is), and the landing-page content check requires the new link instead of the GitHub Pages one.
- **spek's Data and network page** (both languages): the static pages load no font from Google Fonts.
- **Third-party notices:** the demo carries the notices of the code it bundles (spek 1.20.2); the build
  refuses a demo without them, and the site's notices file points to them (design D5).
- spek's GitHub Pages copy is untouched: it keeps serving, and spek's README badges live there.

## Capabilities

### Modified Capabilities

- `project-website`: a new requirement covers serving spek's demo; spek's network-behavior statement
  changes for the static pages; spek's landing page links to the demo on the site; the origins
  requirement points to the demo's own requirement; the notices requirement points to the notices the demo carries.

## Impact

- `site/scripts/`: a new build step (`add-spek-demo.mjs`, self-tested like every check) right after
  `astro build`; `build.mjs` and the root `scripts/site-boundary.test.mjs` step list; `check-live.mjs`,
  `check-content.mjs`, `write-notices.mjs`; `astro.config.mjs` (the link validator's exclude list); the
  root `scripts/scenario-coverage.test.mjs`.
- **The site's build now needs to reach `raw.githubusercontent.com`.** Cloudflare's build already
  fetches from GitHub (`git fetch --tags`); a failure there fails the build, which leaves the previous
  deployment live.
- About 5 MB more per deploy, within Cloudflare Pages' 25 MiB file limit.
- `site/README.md` (the pin, the release routine, the build-step table, the network need) and
  `site/DEPLOY.md` (the network need, email obfuscation, the live check's list).
- A new site devDependency: `mdast-util-from-markdown`, already in the lockfile as a transitive one.
- No change to the desktop app.
