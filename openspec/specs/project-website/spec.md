# project-website Specification

## Purpose
The public website at `spekterm.com` of two products — spekterm at the root and spek, the read-only
OpenSpec viewer spekterm's side panel is built on, under `/spek/` — each with a landing page and user
documentation in English and Traditional Chinese; built from this repository, kept out of the desktop app,
and held to the same honesty about each product's behavior (platforms, network, screenshots) that the
app's own specs require.

## Requirements

### Requirement: The site is built from the repository and stays out of the app

The website SHALL be built from a self-contained directory of this repository with its own dependency
declaration and lockfile. The root project SHALL NOT declare the site's directory as a workspace or list
it in its lockfile, and the desktop packaging configuration SHALL NOT select any file under the site's
directory. (Root and site may depend on some of the same packages; that is not a leak.)

In this capability, **a page** is a page listed in the built site's sitemap. The not-found page is not one:
it exists in English only, its language switch is exempt from the parity rules, and it SHALL still carry
the disclaimer and the third-party notices link.

#### Scenario: Packaging selects nothing from the site

- **WHEN** the desktop packaging configuration's file selections (included files, extra files, extra
  resources) are matched against a path under the site's directory
- **THEN** none selects it

#### Scenario: The root project does not adopt the site

- **WHEN** the root `package.json` and root lockfile are read
- **THEN** no workspace names the site's directory and the lockfile has no entry for the site's package or
  any path under the site's directory

### Requirement: spekterm.com is the canonical host

The site SHALL be served at `https://spekterm.com`. Requests to `www.spekterm.com`, `spekterm.app`, and
`www.spekterm.app` SHALL be answered with a permanent redirect to `https://spekterm.com`, preserving the
path and query. Every page SHALL declare its canonical URL on `https://spekterm.com`, so that any other
host serving the same build (such as the hosting provider's own host name) points back to it.

#### Scenario: A redirecting host keeps the path

- **WHEN** a client requests `https://spekterm.app/docs/install/?x=1`
- **THEN** the response is a permanent redirect to `https://spekterm.com/docs/install/?x=1`
- **AND** the same holds for `www.spekterm.com` and `www.spekterm.app`

#### Scenario: Every page names its canonical URL

- **WHEN** every page of the built site is read
- **THEN** each declares a canonical URL whose host is `spekterm.com` and whose path is that page's path

### Requirement: Both languages carry the same pages

The site SHALL be published in English at the root path and in Traditional Chinese under `/zh-tw/`, and
every page SHALL offer a switch to the same page in the other language. Every page, every interface string
of the site's own components, and every screenshot SHALL exist in both languages. The site's build SHALL
fail when any of them exists in only one language.

A screenshot of an interface that has only one language (spek's) is **language-neutral**: it is kept once,
apart from the per-language screenshots, and used by the pages of both languages. It is exempt from the
per-language rule above and from nothing else.

Whether a translation says the same thing as its source is not machine-checkable; it is reviewed by the
maintainer.

#### Scenario: A page in one language only fails the build

- **WHEN** a documentation page is added in English with no Traditional Chinese counterpart, and the site
  is built
- **THEN** the build fails and names the page that lacks a counterpart

#### Scenario: A component string in one language only fails the build

- **WHEN** an interface string of a site component is defined for one language only, and the site is built
- **THEN** the build fails and names the string

#### Scenario: A screenshot in one language only fails the build

- **WHEN** a screenshot exists for English and not for Traditional Chinese, and the site is built
- **THEN** the build fails and names the screenshot

#### Scenario: A language-neutral screenshot does not need a counterpart

- **WHEN** a screenshot exists only among the language-neutral screenshots, and the site is built
- **THEN** the parity check does not report it

#### Scenario: The language switch leads to the same page

- **WHEN** the language switch of every page of the built site is read
- **THEN** on each, the other language's entry targets that page's counterpart (for example `/docs/install/`
  offers `/zh-tw/docs/install/`, and `/spek/docs/install/` offers `/zh-tw/spek/docs/install/`)

### Requirement: The landing page states what spekterm is and where it runs

The landing page, in both languages, SHALL contain, in the page's own content (not its header or footer):

- a statement of what spekterm is that names Claude Code and OpenSpec;
- a screenshot showing a session next to the OpenSpec side panel;
- the platform status: builds are available for Linux, and macOS and Windows are not supported yet —
  stated next to the first download button;
- a download link (see "Downloads link to the latest release");
- links to the documentation, the source repository, and the releases, and to spek's landing page.

Every page and the not-found page SHALL carry a statement that spekterm and spek are not affiliated with
Anthropic or the OpenSpec project.

Neither the site nor the repository's READMEs SHALL describe spekterm as an app for Linux only — the
platform status describes the current builds, not a design limit.

#### Scenario: The landing page carries the required content

- **WHEN** the main content of the built landing page is read in either language, without the footer
- **THEN** it names Claude Code and OpenSpec, includes the side-panel screenshot, states the platform
  status, and links to the download, the documentation, the repository, the releases, and spek's landing
  page

#### Scenario: Every page carries the disclaimer

- **WHEN** every page of the built site and the not-found page are read
- **THEN** each contains the non-affiliation statement, naming spekterm and spek as separate words

#### Scenario: Nothing says Linux only

- **WHEN** the text of every built page, `README.md`, and `README.zh-TW.md` is searched,
  case-insensitively, for "Linux only", "Linux-only", 「只支援 Linux」, 「僅支援 Linux」, and 「Linux 專用」
- **THEN** there is no match

### Requirement: Every page carries the brand and a share preview

Every page SHALL carry its product's brand (see "The site serves two products"); the not-found page
carries spekterm's. The page SHALL show its product's logo in the site header and SHALL declare exactly one
tab icon — its product's, which the site itself serves. Every page SHALL declare its product's share image
(`og:image` and `twitter:image`) on `https://spekterm.com` in the page's own language, and the site SHALL
serve that image. spekterm's logo, tab icon, and share images are derived from the app's icon; spek's from
spek's logo, as spek's repository publishes it.

The site's build SHALL fail when a page declares a tab icon or a share image that the build does not
contain, when a page or the not-found page has no header logo or another product's, when a page declares
no tab icon, more than one, or another product's, or when a page's share image is missing, another
product's, or in the other language.

#### Scenario: A declared tab icon that is not built fails the build

- **WHEN** the pages declare `/favicon.svg` as their tab icon and the built site has no such file
- **THEN** the build fails and names the icon

#### Scenario: A page without the header logo fails the build

- **WHEN** a page or the not-found page has no logo image in its header
- **THEN** the build fails and names the page

#### Scenario: Each page shares an image in its own language

- **WHEN** every page of the built site is read
- **THEN** each spekterm page declares `og:image` and `twitter:image` as `https://spekterm.com/og/en.png`
  in English and `https://spekterm.com/og/zh-tw.png` in Traditional Chinese, each spek page as
  `https://spekterm.com/og/spek-en.png` and `https://spekterm.com/og/spek-zh-tw.png`, and the built site
  contains that file

#### Scenario: A spek page with spekterm's brand fails the build

- **WHEN** a spek page shows spekterm's header logo, or declares spekterm's tab icon (alone or beside its
  own) or share image
- **THEN** the build fails and names the page

### Requirement: The documentation is the user guide

The site SHALL publish spekterm documentation covering at least: installation; setting up a first
workspace; terminals and sessions (restore, hibernation, worktrees); the OpenSpec side panel; the
conversation view; files and quick open; the inbox and Slack; handoffs; keyboard shortcuts; settings; data
and network; and troubleshooting. (spek's documentation is its own requirement.)

The repository's READMEs SHALL link to the documentation and SHALL keep what `desktop-packaging` requires
the README to state, so that someone reading the repository can install without leaving it.

#### Scenario: Every required topic has a page

- **WHEN** the built site's pages are listed in either language
- **THEN** each topic above has a page

#### Scenario: The READMEs point to the documentation

- **WHEN** `README.md` and `README.zh-TW.md` are read
- **THEN** each links to `https://spekterm.com/docs/`

### Requirement: Downloads link to the latest release

Every spekterm download link on the site SHALL point to the latest release page of spekterm's source
repository. The site's pages SHALL NOT carry an app version number, so that publishing a release never
requires rebuilding the site. Releases are published as full (not pre-release) releases; the latest
release page shows the newest of those. (spek's install links point at its marketplace listings and its
source repository; see "spek's landing page states what spek is and how to get it".)

#### Scenario: Download links target the latest release page

- **WHEN** every link on the built site whose target is spekterm's source repository's releases is collected
- **THEN** each targets `https://github.com/spekhq/spekterm/releases/latest`

#### Scenario: The pages do not carry a version number

- **WHEN** the HTML pages of the built site (not the third-party notices) are searched for every version
  the app has been released under (the repository's `v*` tags, without the `v`) and for the version in the
  root `package.json`
- **THEN** there is no match

### Requirement: The site loads nothing from another origin but Google Analytics, and that only with consent where it is required

The site SHALL measure where its readers come from with Google Analytics (the Google tag,
`https://www.googletagmanager.com/gtag/js` with the site's measurement ID). Apart from that tag, the site
SHALL NOT load any script, style sheet, font, image, or frame from an origin other than its own; links that
the reader follows are not loads. The hosting's responses SHALL NOT set cookies; the cookies Google
Analytics sets in the reader's browser are the only ones the site has. This SHALL hold for what the hosting
serves, not only for what the build produces, because the hosting can inject content without any change to
the repository.

The Google tag SHALL be added by the site's consent script at run time, never by the built pages
themselves. The consent script SHALL ask a reader whose time zone is in the European Economic Area, the
United Kingdom, or Switzerland — or cannot be read — before loading the tag, and SHALL load nothing from
another origin until that reader allows it; other readers are not asked. The reader's choice SHALL be kept
in the browser and SHALL win over the time zone on later visits, for every reader. Every page SHALL offer a
way to show the question again; declining after having allowed SHALL remove Google Analytics' cookies. The
decision is made in the browser because the hosting serves every reader the same bytes; a time zone is an
approximation of where the reader is.

The site's build SHALL fail when the built output references a resource from another origin, the Google tag
included. References a script would make at run time are not visible to the build; the site's own scripts
SHALL NOT make any other than the consent script's Google tag, and the tag's own are Google's. spek's live
demo, which the site serves but did not write, is held by its own requirement ("The site serves spek's live
demo").

The served site SHALL be checked after deployment and after any change to the hosting's settings; that
check needs a deployed site and is run by the maintainer.

#### Scenario: A resource from another origin fails the build

- **WHEN** a built page — including its `<style>` elements and `style` attributes — or a built style
  sheet references a script, style sheet, font, image, or frame on another origin, and the site is built
- **THEN** the build fails and names the reference

#### Scenario: A static Google tag fails the build

- **WHEN** a built page loads the Google tag through its own `<script src>`
- **THEN** the build fails and names the reference, since that tag would load before the reader was asked

#### Scenario: A reader in Europe is asked before anything loads

- **WHEN** a page opens in a browser whose time zone is in the European Economic Area, the United Kingdom,
  or Switzerland, or cannot be read, and no choice is stored
- **THEN** the page shows the consent question and loads nothing from another origin; allowing loads the
  Google tag and keeps the choice, declining loads nothing and keeps the choice

#### Scenario: A reader elsewhere is not asked

- **WHEN** a page opens in a browser whose time zone is outside those regions and no choice is stored
- **THEN** the page loads the Google tag without showing the question

#### Scenario: A stored choice wins and can be changed

- **WHEN** a choice is stored
- **THEN** the page follows it whatever the time zone; the page's footer shows the question again, and
  declining removes Google Analytics' cookies

#### Scenario: Inline data and plain links do not fail the build

- **WHEN** the built output contains `data:` URLs and hyperlinks to other origins
- **THEN** the build does not fail on them

#### Scenario: The served site matches the build and sets no cookie

- **WHEN** the maintainer runs the live check against the site deployed from a given commit
- **THEN** every page, the third-party notices, and the response to a path that does not exist are served
  without a `Set-Cookie` header and with a body identical to the corresponding file of that commit's build
  (the last with status 404 and the not-found page's body)

### Requirement: The documentation states the app's network behavior

spekterm's documentation SHALL state, in a page about data and network:

- what the app itself connects to and when: Slack (or the endpoint the user configured) only after Slack
  credentials are saved; remote `https:` images in rendered markdown; links the user opens, in the user's
  browser;
- which programs the app starts that make their own connections: the `claude` CLI; the `openspec` CLI,
  including that it sends anonymous usage statistics and how to turn them off in a way that works however
  spekterm is started; and the user's login shell at startup;
- that the app's own checks cannot observe what those programs do.

The page SHALL be revisited whenever the app's network allow-list (`workspace-app-shell`) changes; the
allow-list names this page.

#### Scenario: The page states the app's own connections and the started programs

- **WHEN** spekterm's data and network page of the built site is read in either language
- **THEN** it names Slack, remote images, the `claude` CLI, the `openspec` CLI with its usage statistics and
  the `openspec config set telemetry.enabled false` opt-out, and the login shell, and says the app cannot
  observe the started programs' connections

### Requirement: Screenshots come only from the capture script

Every screenshot on the site SHALL be produced by the repository's capture script, in an environment built
from an allow-list (an invented home directory, the started programs' usage statistics turned off, and only
display variables from the process that runs it). For spekterm it runs the app with a fresh user-data
directory, the invented home's shell prompt and git identity, fixture repositories at a fixed generic path,
and a stand-in agent. For spek it builds a static spek page from the same fixture repository with spek's own
static-page builder, from a spek checkout the maintainer names that is clean and at a spek release tag
(`v<major>.<minor>.<patch>`), and records that tag; then it shows that page. A screenshot taken from anyone's working session — including the
screenshots committed in spek's repository — SHALL NOT be committed.

Before each capture the script SHALL read the text on screen — the page text, the values of text fields,
and the terminals' contents — and abort if it contains a word or path that the repository's
content-hygiene rules forbid. The same read SHALL abort if it does not contain a known fixture text that
that page shows, so that reading an empty or wrong page cannot pass.

The script SHALL record a hash of every screenshot it writes. A unit test SHALL fail when a committed
screenshot is not recorded or does not match its hash, or when a recorded screenshot is missing. Every
screenshot SHALL be reviewed by the maintainer before it is committed.

#### Scenario: Forbidden text on screen aborts the capture

- **WHEN** the text on screen at capture time contains a word on the content-hygiene list or a
  maintainer home path
- **THEN** the capture is aborted for that screenshot and the script exits non-zero

#### Scenario: An empty read aborts the capture

- **WHEN** the text read at capture time does not contain the known fixture text for that page
- **THEN** the capture is aborted and the script exits non-zero

#### Scenario: A screenshot not written by the script fails the test

- **WHEN** a screenshot in the site's screenshot directory is replaced or added without updating the
  recorded hashes
- **THEN** the unit test fails and names the file

#### Scenario: A recorded screenshot that is missing fails the test

- **WHEN** a recorded screenshot is deleted
- **THEN** the unit test fails and names the file

#### Scenario: A spek checkout that is not a clean release aborts the spek shots

- **WHEN** the spek checkout has uncommitted changes or its HEAD carries no `v<major>.<minor>.<patch>` tag
- **THEN** the spek shots are not captured and the script exits non-zero, naming the reason

### Requirement: The site publishes its third-party notices

The site SHALL publish, at a stable path linked from every page and from the not-found page, the name and
license text of every third-party package whose code or styles are shipped to the reader's browser. When it
is unclear whether a package ships, it SHALL be listed.

spek's live demo is bundled by spek's build, which this site cannot see into, so the demo carries the notices
of the packages it bundles itself, embedded in the file (spek 1.20.2 and later). The notices file SHALL say
so and point to them rather than repeat them, and the build SHALL fail when the demo it serves carries none
(see "The site serves spek's live demo").

#### Scenario: The notices list what the browser receives

- **WHEN** the site is built
- **THEN** the notices file exists and lists, with license text, each package whose files appear in the
  built scripts and style sheets, and points to the notices spek's live demo carries

#### Scenario: Every page links to the notices

- **WHEN** every page of the built site and the not-found page are read
- **THEN** each links to the notices file

### Requirement: The site's build is the gate to publishing

The site SHALL be published only from the `master` branch, by the hosting building the site's directory,
and only when that build succeeds. Other branches SHALL NOT be published at any address. The build SHALL
fail — and therefore nothing SHALL be published — when any check this capability assigns to the build
fails, and when any of these fails: the site's type check; the repository's content-hygiene check and its
restrictive-license-wording check; a broken link or anchor in the documentation's content.

#### Scenario: A content-hygiene violation stops the build

- **WHEN** a page under the site's directory contains a word on the content-hygiene list, and the site is
  built
- **THEN** the build exits non-zero

#### Scenario: A broken documentation link stops the build

- **WHEN** a documentation page links to a page or anchor that does not exist, and the site is built
- **THEN** the build exits non-zero and names the link

#### Scenario: A failed build leaves the published site in place

- **WHEN** the hosting's build of a new `master` commit fails
- **THEN** the previously published site keeps being served

### Requirement: The site serves two products

The site SHALL be the website of two products: spekterm, whose pages are at the root (`/`, `/docs/…`),
and spek, whose pages are under `/spek/` (`/spek/`, `/spek/docs/…`); the Traditional Chinese pages of each
are under `/zh-tw/` with the same paths (`/zh-tw/spek/…`). A page belongs to spek when its path, without the
language prefix, starts with `/spek/`; every other page, and the not-found page, belongs to spekterm.

Every page SHALL name its product in the site header — that product's logo and name, linking to that
product's landing page in the page's language — and SHALL offer a link to the other product's landing page
in the same language, visible at phone width. The documentation sidebar and the previous / next page links
of a page SHALL stay within its own product.

Search covers both products' pages; a result from the other product is a deliberate cross-link, not a
leak.

#### Scenario: The header names the page's product and links to the other

- **WHEN** every page of the built site is read
- **THEN** on a spekterm page the header's product link targets `/` (or `/zh-tw/`) and the switch targets
  `/spek/` (or `/zh-tw/spek/`), and on a spek page the reverse

#### Scenario: A sidebar shows only its own product's pages

- **WHEN** the sidebar of every documentation page of the built site is read
- **THEN** a spekterm page's sidebar has no link under `/spek/` or `/zh-tw/spek/`, and a spek page's sidebar
  has only links under `/spek/` or `/zh-tw/spek/`

#### Scenario: Previous and next stay within the product

- **WHEN** the previous and next page links of every documentation page of the built site are read
- **THEN** each targets a page of the same product

### Requirement: Product-specific parts follow the page's product

Everything on a page that belongs to one product SHALL be that of the page's product: the page title's site
suffix and `og:site_name`; the share image's alternative text; the home-screen icon; the source repository
and license links in the header and the footer. spekterm's platform status (builds for Linux; macOS and
Windows not yet) SHALL appear only on spekterm pages.

#### Scenario: A spek page carries nothing of spekterm's

- **WHEN** every spek page of the built site is read
- **THEN** its title ends with "spek", its `og:site_name` is "spek", its `og:image:alt` is spek's, its
  home-screen icon is spek's and the built site contains it, it does not contain spekterm's platform
  status, and no header or footer link targets `https://github.com/spekhq/spekterm` or anything under it

#### Scenario: A spekterm page links to its own repository

- **WHEN** every spekterm page of the built site is read
- **THEN** its header and footer repository links target `https://github.com/spekhq/spekterm`

### Requirement: spek's landing page states what spek is and how to get it

spek's landing page, in both languages, SHALL contain, in the page's own content (not its header or
footer):

- a statement of what spek is that names OpenSpec and says that spek only reads;
- a screenshot of spek showing a change or a spec;
- every form spek ships in, each with where to get it: the web app (from its source repository), the VS
  Code extension (its Visual Studio Marketplace listing), the JetBrains plugin (its JetBrains Marketplace
  listing), and the GitHub Action (its GitHub Marketplace listing);
- links to spek's documentation, spek's source repository, and spek's live demo as this site serves it
  (`/spek/demo/`, from either language);
- what spekterm takes from spek, with a link to spekterm's landing page.

spek's pages SHALL NOT carry a spek version number: spek releases often, and a number on a page goes stale
before anything else on it. Whether a page carries one is reviewed by the maintainer — spek's release tags
are not in this repository, so the build cannot list them.

#### Scenario: spek's landing page carries the required content

- **WHEN** the main content of the built spek landing page is read in either language, without the footer
- **THEN** it names OpenSpec, includes a spek screenshot, and links to the source repository, the Visual
  Studio Marketplace listing, the JetBrains Marketplace listing, the GitHub Marketplace listing, the live
  demo at `/spek/demo/`, spek's documentation, and spekterm's landing page

### Requirement: spek's documentation is spek's user guide

The site SHALL publish spek documentation covering at least: installing and running each form (the web
app, the VS Code extension, the JetBrains plugin); browsing (the dashboard, specs, changes, schemas, the
timeline, and search); worktree aggregation, including jj workspaces as an experimental option and which
forms aggregate; the GitHub Action and its badges; data and network; and frequently asked questions,
including how spek relates to spekterm. Every statement SHALL hold for spek's latest release and for its
default branch, which the web app (cloned) and the GitHub Action (by default) run; the maintainer reviews
this against spek's repository.

#### Scenario: Every spek topic has a page

- **WHEN** the built site's pages are listed in either language
- **THEN** each spek topic above has a page under `/spek/docs/` (or `/zh-tw/spek/docs/`)

### Requirement: spek's documentation states its network behavior

spek's documentation SHALL state, in a page about data and network, for each form where it differs:

- where each form reads the repository (the reader's machine; the GitHub Actions runner for the Action;
  a snapshot embedded in the page for the static pages), and that spek has no account, telemetry, or
  analytics of its own;
- that the web app loads its font from Google Fonts, and that the static pages (the live demo and the
  GitHub Action's output), the VS Code extension and the JetBrains plugin do not;
- that remote `https:` images in rendered markdown are loaded by the web app, the static pages, and the
  JetBrains plugin, and blocked by the VS Code extension;
- the address and port the web app's API server listens on, which origins it accepts requests from, and
  that it lists directories of the machine on request;
- which programs spek runs: `git`; `jj`, whenever jj is installed, to detect jj workspaces — whether or not
  jj aggregation is turned on; and the `openspec` CLI, including that the CLI sends anonymous usage
  statistics and how to turn them off;
- what the GitHub Action does in the reader's GitHub Actions: checks out spek's source at the version it is
  given (its default branch unless set), installs spek's dependencies and the `openspec` CLI from npm, and
  runs the CLI with its usage statistics turned off.

#### Scenario: The spek data and network page names what spek connects to

- **WHEN** spek's data and network page of the built site is read in either language
- **THEN** it names Google Fonts, remote images, port 3001 with the address the server listens on, `git`,
  `jj`, the `openspec` CLI with the `openspec config set telemetry.enabled false` opt-out, and GitHub
  Actions

### Requirement: The site serves spek's live demo

The site SHALL serve spek's live demo at `/spek/demo/`: the demo page of one spek release, byte for byte as
that release committed it (`docs/demo.html` at the release's tag). The release SHALL be pinned in the
repository by its tag and the file's SHA-256, and the build SHALL fail — publishing nothing — when the file
it obtains does not match the pin, or when the repository's content-hygiene matcher finds the maintainer's
home path or a word on its list in the file. Moving the pin is part of updating the site for a spek release.

The demo is a file the site serves, not a page of the site, as the third-party notices are. It is spek's
application and SHALL NOT be altered to carry the site's page parts: the requirements on pages — the
header and product switch, both languages, the brand and share preview, the canonical URL, the footer and
its notices link, the consent question — do not apply to it, and it SHALL NOT be listed in the sitemap.
It SHALL load nothing from another origin, analytics included. The build SHALL hold this as far as the
file shows it: the origin check reads the demo's elements as it reads every built file, and the build
step that adds the demo SHALL fail when the demo's text references Google's analytics hosts
(`googletagmanager.com`, `google-analytics.com`), the site's measurement ID, or the site's consent key, or
when its embedded content holds a remote Markdown image — inline or by reference — read as CommonMark, so
that an image written inside a code span or a fenced block, which renders as text, does not count. Raw HTML
in Markdown is not counted either: spek renders Markdown without raw HTML, so an `<img>` written there is
shown as text and loads nothing. Its served bytes SHALL be checked by the
live check like a page.

The demo SHALL carry the third-party notices of the code it bundles, embedded in the file; the step that adds
it SHALL fail when the demo has no non-empty `#third-party-notices` element.

The build SHALL fail when the built output has no demo at `/spek/demo/`, or one whose SHA-256 is not the
pin's.

#### Scenario: The pinned demo is served

- **WHEN** the site is built
- **THEN** `/spek/demo/index.html` in the built output is byte for byte the file at the pinned tag, and
  its SHA-256 equals the pin

#### Scenario: A file that does not match the pin stops the build

- **WHEN** the file obtained for the pinned tag has a different SHA-256 than the pin
- **THEN** the build exits non-zero and names both hashes, and nothing is written to `/spek/demo/`

#### Scenario: A demo carrying a home path stops the build

- **WHEN** the obtained demo contains the maintainer's home path
- **THEN** the build exits non-zero, naming the hygiene hit without printing the matched text

#### Scenario: A demo loading from another origin stops the build

- **WHEN** the served demo contains an element that loads a script, style sheet, font or image from
  another origin
- **THEN** the build's origin check fails and names it

#### Scenario: A demo referencing analytics stops the build

- **WHEN** the obtained demo contains `googletagmanager.com`, `google-analytics.com`, the site's
  measurement ID, or the site's consent key
- **THEN** the build exits non-zero and names what it found

#### Scenario: A demo whose content loads a remote image stops the build

- **WHEN** a string in the obtained demo's embedded data holds a Markdown image, inline or by reference,
  whose source is an `https:` URL
- **THEN** the build exits non-zero and names the URL

#### Scenario: An image written as code does not stop the build

- **WHEN** a string in the demo's embedded data shows `![x](https://example.com/a.png)` inside a code span
  or a fenced block, or discusses `<img src="https://…">`
- **THEN** the build does not fail on it

#### Scenario: A demo without its third-party notices stops the build

- **WHEN** the obtained demo has no `#third-party-notices` element, or an empty one
- **THEN** the build exits non-zero

#### Scenario: A build without the demo fails

- **WHEN** the built output has no `/spek/demo/index.html`, or its SHA-256 differs from the pin
- **THEN** the build exits non-zero

#### Scenario: The live check compares the demo

- **WHEN** the maintainer runs the live check against the deployed site
- **THEN** `/spek/demo/` is served with status 200, no `Set-Cookie` header, and a body identical to the
  build's file
