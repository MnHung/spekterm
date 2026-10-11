## ADDED Requirements

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

## MODIFIED Requirements

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
