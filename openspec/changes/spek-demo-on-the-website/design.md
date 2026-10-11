## Context

spek's demo is one self-contained HTML file (about 5 MB): spek's web app, built as a single IIFE bundle
with spek's own OpenSpec content embedded and a hash router, so it works from any path and from `file://`.
spek commits it as `docs/demo.html` at release time only (`Rebuild demo for vX.Y.Z`), and GitHub Pages
publishes `docs/` as committed.

The site pins everything else it takes from spek to a release tag: the logos are copied from spek's
`logo/` at a tag, and the screenshots are captured from a clean checkout at a tag recorded in
`neutral/SOURCE` (`site/README.md`). Its build is the gate: `scripts/build.mjs` runs each check after its
own `--self-test`, and `check-origins.mjs` reads every `.html` and `.css` file under `dist/` — not only the
pages in the sitemap. `check-content.mjs` reads the sitemap's pages (and, after this change, the demo's
presence and hash). `check-live.mjs` compares the sitemap's
pages, the notices file, and the not-found response with what the hosting serves.

spek 1.20.2's demo (SHA-256 `23c7382e…591e`, fetched from the tag and compared with spek's committed file)
loads nothing from another origin, carries no home path — spek's build refuses both since 1.20.1 — and
carries the third-party notices of what it bundles (1.20.2).

## Goals / Non-Goals

**Goals:** the demo served from spekterm.com, reproducibly, as exactly the file a spek release shipped;
held to the site's origin and content-hygiene rules by the build; checked by the live check; linked from
spek's landing page; the stale font statement corrected.

**Non-Goals:** changing the demo (it is spek's artifact; a change to it is a spek release); a localised
demo (spek's interface has one language); retiring the GitHub Pages copy (spek's badges live there, and
old links keep working); a local `npm run dev` that serves the demo (the dev server serves `public/` and
pages, not build-step output — `/spek/demo/` is a 404 there, and the landing page's link works on any
build).

## Decisions

### D1. Fetch the release's file at build time, pinned by tag and hash

`site/src/spek-demo.json` holds `{ "tag": "v1.20.2", "sha256": "…" }`. A new build step,
`scripts/add-spek-demo.mjs`, fetches `https://raw.githubusercontent.com/spekhq/spek/<tag>/docs/demo.html`,
fails unless its SHA-256 equals the pin, runs the repository's `hygieneHits`
(`scripts/lib/public-hygiene.mjs`) over its text and fails on any hit, and writes it to
`dist/spek/demo/index.html`. It also fails when the demo's text holds the Google tag's URL, the site's
measurement ID or consent key (imported from `src/analytics.mjs`) — matched by Google's analytics host
names, not the site's full tag URL, so a tag with another ID is refused too —, or a remote image in its embedded
content (D2). It runs right after `astro build` (which empties `dist/` and, inside it, writes the sitemap
and the search index — so the demo is in neither), before `parity` and `origins`; the origins check then
reads the demo like any other built file — no exemption.

The step is asynchronous (a fetch), so it does **not** use `lib.mjs`'s `main` / `selfTest`, which are
synchronous: an async `run` returns a promise that `main` reads as "no problems" and prints `passed`
(measured). It handles its own exit code with top-level `await`, as `check-live.mjs` does, and bounds the
fetch with `AbortSignal.timeout`. Its self-test serves fixtures from a local HTTP stub, so it needs no
network. Two of its fixtures cannot be written literally: the internal words exist in the repository only
as hashes, so the "listed word" case passes its own control word through `hygieneHits(text, { hashes })`;
and the home path is composed from `MAINTAINER_HOME`, since a literal in the script would trip the
repository's own hygiene test — the build's "root content guards" step.

Because a step that silently wrote nothing would publish a dead link with every later check green,
`check-content`'s structural part also requires `dist/spek/demo/index.html` to exist with the pinned hash.
The pin is passed to `checkContent` as a parameter (read from `spek-demo.json` in a real run, computed
from the fixture's own content in the self-test), since no fixture can carry the real 5 MB file.

**Alternatives considered.**
- *Commit the file into this repository at each spek release*, the way the logos are. 5 MB a release,
  forever, in a repository a desktop app is cloned from; and the content-hygiene test would read it on
  every run of the root test suite.
- *Build it from spek's source during the site build.* A second toolchain (spek's `npm ci`, its core and ui
  builds, the OpenSpec CLI) inside the site's build, for a file spek already builds and publishes.
- *Fetch spek's GitHub Pages copy.* That URL follows spek's `master`, not a release: a push to spek would
  change what this site serves without a commit here, and the hash pin would break the next build.

A tag can be moved; the hash is what makes the pin hold. Fetching from GitHub at build time adds a
dependency the build did not have; a failure stops the build, and a stopped build leaves the previous
deployment live (`DEPLOY.md`).

The hygiene matcher's internal-word list is hashes, so the step can run it without naming the words. A hit
prints the matcher's own output (hash prefixes, or "home path"), never the matched text.

### D2. The demo is a served file, not a page of the site

The site's page requirements — header and product switch, both languages, share image, canonical URL,
footer, notices link, consent script — describe Starlight pages. The demo is spek's application, and
rewriting it to carry them would make it something spek did not release. So it is served as the notices
file is: at a stable path, not in the sitemap, not indexed by search, and outside `check-content` and
`check-parity`, which read the sitemap and the content collections.

It carries **no analytics**: the consent script is injected by Starlight's head into pages only, and the
demo never passes through Starlight. That keeps it consistent with spek's own pages, which say spek has no
analytics. The origins check does **not** guarantee this on its own — the consent script is an inline
script that adds the Google tag at run time, and every page passes the origins check while carrying it
(measured). What holds it is the pinned hash (the file is the reviewed release) plus the step's explicit
refusal of the tag's URL, the measurement ID and the consent key, and the live check for what is served.

Run-time loads are bounded the same way. spek's `demo-page` requirement excludes "a remote image an
artifact's Markdown links to" from its own guarantee, and spek's *Data and network* page says the static
pages load such images. This site's origins requirement would forbid them here, so the step parses the
demo's embedded data (`window.__DEMO_DATA__`'s JSON) and reads every string as CommonMark
(`mdast-util-from-markdown`, declared as a site devDependency): an `image` node, or an `imageReference`
resolved through its definition, with a remote URL fails the build. The parser is what keeps code spans
and fenced blocks out — spek's own changes discuss image syntax in both — and what catches reference-style
images a regular expression would miss. Raw HTML `<img>` is not counted: spek renders Markdown with
react-markdown and remark-gfm, without raw HTML, so it shows as text and loads nothing; a pattern for it
would fail v1.20.2 on its own code spans (measured: 2 false hits, 0 real images). Strings that are not
Markdown (a data artifact's YAML or JSON) are read the same way, which errs toward failing, not missing. The origins requirement names the demo's own requirement for this, rather
than counting spek's scripts among "the site's own".

`/spek/demo/` is in spek's path space, so the header-and-product rules would, read literally, apply to
it. The new requirement states the exception and why, so a later check that walks `dist/` for pages does
not have to rediscover it.

### D3. The live check covers it

`check-live.mjs` adds `/spek/demo/` to the files it compares byte for byte (next to the notices), so a
hosting feature that rewrote it — an injected script, an obfuscated address — is caught like on any page.
Its self-test gains a case where only the demo differs: the existing injection case rewrites every `.html`,
so it would stay red through the pages even if the demo were never compared.

The demo contains an email address inside its data script (`platform@example.com`, spek's own fixture
text). Cloudflare's Email Address Obfuscation is left at the zone's default (`DEPLOY.md` §4), whose
premise "no page contains an email address" no longer holds for this file. Whether it rewrites text
inside `<script>` is not confirmed; the live check would catch a rewrite, and `DEPLOY.md` records it.

### D4. Links

spek's landing page hero links to `/spek/demo/` in both languages (one demo; the Traditional Chinese
landing page links the same file). `content-plan.json`'s required spek landing links and
`check-content.mjs`'s self-test fixtures change with it.

`starlight-links-validator` **does** read hero actions in frontmatter, and it runs inside `astro build`,
before the demo exists — and it would reject a non-Starlight path even after (measured: the build stops on
`/spek/demo/ invalid link`). So `/spek/demo/` joins `/third-party-notices.txt` in its `exclude` list, and
the comment above it, which says the landing page's buttons are not seen by the validator, is corrected:
they are (the `/spek/docs/` button is validated today). The structural check in D1 is what verifies the
link's target exists.

### D5. Third-party notices: the demo carries its own, and the build requires them

The demo bundles about ninety third-party packages (React, React Router, the Markdown and highlighting stack,
d3 modules) and a font. This site's notices requirement covers every package "shipped to the reader's
browser", and its notices file is titled as what *this website* ships — so serving the demo makes this site a
distributor of those packages. `write-notices.mjs` cannot list them: it reads the module graph of the site's
own build, and the demo's is spek's.

spek 1.20.2 embeds them: its demo build records the modules rendered into the bundle and writes each package's
name, version, licence and licence text into a `<script type="text/plain" id="third-party-notices">`. The
notices requirement is modified to say the demo carries its own and the notices file points to them; the
add-demo step refuses a demo without a non-empty `#third-party-notices`, so a pin moved back to an older
release, or a spek build that lost the list, stops the build.

**Alternatives considered.**
- *A stated exception, serving 1.20.1 before spek carried the notices.* Rejected by the maintainer in favour
  of fixing the demo first.
- *Generate the demo's notices here from spek's lockfile at the tag.* It would list every dependency of
  spek's web package rather than what the bundle contains, needs licence texts the lockfile does not carry,
  and duplicates work that belongs to spek's build.

## Risks / Trade-offs

- **A build depends on GitHub being reachable.** Mitigated by the pin (a wrong or missing file stops the
  build rather than publishing it) and by the hosting keeping the previous deployment on a failed build.
- **A local `npm run build` now needs network access** to GitHub, as the hosting's already does.
- **The demo goes stale between spek releases unless the pin moves.** The "When spek releases" routine in
  `site/README.md` gains the step; nothing checks it automatically, as for the logos and screenshots.
- **One more 5 MB file per deploy.** Within Cloudflare Pages' limits (25 MiB per file).
