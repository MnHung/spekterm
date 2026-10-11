## 1. The build step

- [x] 1.1 Add `site/src/spek-demo.json` pinning `v1.20.2` and the SHA-256 of spek's `docs/demo.html` at that tag; verify the hash against a fresh download from the tag.
- [x] 1.2 Write `site/scripts/add-spek-demo.mjs` (design D1, D2) with its own top-level-`await` entry point and exit code (not `lib.mjs`'s synchronous `main` / `selfTest`), a fetch bounded by `AbortSignal.timeout`, and checks that refuse a hash mismatch, a `hygieneHits` hit, `googletagmanager.com` / `google-analytics.com` / the measurement ID / the consent key (the last two imported from `src/analytics.mjs`), a missing or empty `#third-party-notices` element, and a remote Markdown image (inline, or by reference resolved through its definition) in any string of the parsed `window.__DEMO_DATA__`, read with `mdast-util-from-markdown` (design D2), writing `dist/spek/demo/index.html` only when all pass. Its `--self-test` serves fixtures from a local HTTP stub: a matching clean file is written byte for byte; each refusal case writes nothing and exits non-zero, including a reference-style remote image; an image inside a code span, one inside a fenced block, and a code span discussing `<img src="https://…">` pass; the listed-word case passes a control word through `hygieneHits(text, { hashes })`, and the home-path case composes its fixture from `MAINTAINER_HOME` (no literal). Verify `node site/scripts/add-spek-demo.mjs --self-test`, and that a deliberately broken check (one refusal removed) makes the self-test fail.
- [x] 1.3 Declare `mdast-util-from-markdown` as a site devDependency at the version the lockfile already resolves, updating `site/package-lock.json`. Verify `(cd site && npm ci)`.
- [x] 1.4 Add `step('spek demo', ...)` to `site/scripts/build.mjs` right after `astro build`, and the name to `SITE_BUILD_STEPS` in `scripts/site-boundary.test.mjs`. Verify `node --test scripts/site-boundary.test.mjs`.
- [x] 1.5 `site/astro.config.mjs`: add `/spek/demo/` to `starlightLinksValidator`'s `exclude`, and correct the comment above it — hero buttons are validated (design D4). Verify `astro build` passes with the new hero link.

## 2. Checks

- [x] 2.1 `site/scripts/check-content.mjs` structural part: `dist/spek/demo/index.html` exists and its SHA-256 equals the pin, with the pin passed in as a parameter (read from `spek-demo.json` in a real run, computed from the fixture in the self-test); self-test cases for a missing and a different file. `site/src/content-plan.json` and the landing-link fixtures: the required spek demo link becomes `/spek/demo/` (the missing-link case included). Verify `node site/scripts/check-content.mjs --self-test`.
- [x] 2.2 `site/scripts/check-live.mjs`: compare `/spek/demo/` byte for byte (design D3); the self-test fixture gains `spek/demo/index.html` and a case where only the demo differs. Verify `node site/scripts/check-live.mjs --self-test`.
- [x] 2.3 `site/scripts/write-notices.mjs`: the notices file says spek's live demo at `/spek/demo/` carries the notices of the packages it bundles, in its `#third-party-notices` element (design D5); the self-test asserts the statement. Verify `node site/scripts/write-notices.mjs --self-test`.
- [x] 2.4 `scripts/scenario-coverage.test.mjs`: register `spek-demo-on-the-website`, add a row for each of the ADDED requirement's scenarios with its carrier, `greenIfAbsent` and mutation — and none for the MODIFIED requirements' scenarios, which already have rows (the duplicate guard matches by name); revise the rows the modifications change: the landing-link row's note, and the notices row, whose carrier becomes the write-notices self-test assertion of task 2.3. The MODIFIED copy of the origins requirement also brings its four consent scenarios into scope, which no registered change carried until now (the analytics commits registered none): add their rows, carried by `scripts/site-analytics.test.mjs` and `check-origins`' self-test. Verify `node --test scripts/scenario-coverage.test.mjs`.

## 3. Pages (English and Traditional Chinese)

- [x] 3.1 spek landing page hero (`spek/index.mdx`, `zh-tw/spek/index.mdx`): "Try the live demo" links to `/spek/demo/`, without the external icon.
- [x] 3.2 spek *Data and network* page (both languages): the static pages load no font from Google Fonts — the table and any prose that says otherwise.

## 4. Docs

- [x] 4.1 `site/README.md`: the demo's pin beside the brand-assets paragraph; "move the demo pin" in "When spek releases"; a `spek demo` row in the build-steps table (fails on: the file cannot be fetched, a hash mismatch, a hygiene hit, analytics, a remote image); the Build section's network need; the live check's list of what it compares; and line 44's "needs network access for spek's font", which no longer holds from spek 1.20.1.
- [x] 4.2 `site/DEPLOY.md`: the build fetches from `raw.githubusercontent.com`; §4's Email Address Obfuscation premise (the demo's data holds an email address, design D3); §5's list of what the live check compares.

## 5. Verification

- [x] 5.1 Run `(cd site && npm ci && npm run build)`; verify it passes, `dist/spek/demo/index.html` hashes to the pin, it is in neither the sitemap nor the search index, and it contains neither the consent script nor the Google tag.
- [x] 5.2 Serve the built site with `npm run preview` and open `/spek/demo/` in a browser: it renders and navigates (`#/specs`, a change), makes no request to another origin, and the landing page's demo link reaches it in both languages.
- [x] 5.3 Run the repository's `npm test`; verify it passes (content hygiene, site boundary, scenario coverage).
