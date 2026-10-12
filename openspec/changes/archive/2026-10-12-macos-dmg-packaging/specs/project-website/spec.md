## MODIFIED Requirements

### Requirement: The landing page states what spekterm is and where it runs

The landing page, in both languages, SHALL contain, in the page's own content (not its header or footer):

- a statement of what spekterm is that names Claude Code and OpenSpec;
- a screenshot showing a session next to the OpenSpec side panel;
- the platform status: builds are available for Linux (x86_64) and for macOS on Apple Silicon, and
  Windows and Intel Macs are not supported yet — stated next to the first download button;
- a download link (see "Downloads link to the latest release");
- links to the documentation, the source repository, and the releases, and to spek's landing page.

Every page and the not-found page SHALL carry a statement that spekterm and spek are not affiliated with
Anthropic or the OpenSpec project.

Neither the site nor the repository's READMEs SHALL describe spekterm as an app for Linux only — the
platform status describes the current builds, not a design limit. The same holds for macOS: no page SHALL
describe spekterm as an app for Linux and macOS only.

The download call to action SHALL NOT name a single platform's file format as if it were the only download.

#### Scenario: The landing page carries the required content

- **WHEN** the main content of the built landing page is read in either language, without the footer
- **THEN** it names Claude Code and OpenSpec, includes the side-panel screenshot, states the platform
  status naming Linux and macOS on Apple Silicon, and links to the download, the documentation, the
  repository, the releases, and spek's landing page

#### Scenario: Every page carries the disclaimer

- **WHEN** every page of the built site and the not-found page are read
- **THEN** each contains the non-affiliation statement, naming spekterm and spek as separate words

#### Scenario: Nothing says Linux only

- **WHEN** the text of every built page, `README.md`, and `README.zh-TW.md` is searched,
  case-insensitively, for "Linux only", "Linux-only", 「只支援 Linux」, 「僅支援 Linux」, and 「Linux 專用」
- **THEN** there is no match

#### Scenario: Nothing says macOS is unsupported

- **WHEN** the text of every built page, `README.md`, and `README.zh-TW.md` is searched,
  case-insensitively and with whitespace normalised, for "macOS and Windows are not supported",
  "macOS is not supported", "A macOS build is tracked", 「macOS 與 Windows 尚未支援」, 「尚未支援 macOS」,
  and 「macOS 版的進度」
- **THEN** there is no match

#### Scenario: Nothing says Linux and macOS only

- **WHEN** the same text is searched, case-insensitively, for "Linux and macOS only", "macOS and Linux
  only", 「只支援 Linux 與 macOS」, and 「僅支援 Linux 與 macOS」
- **THEN** there is no match

#### Scenario: The download call to action names no single format

- **WHEN** the download buttons of the built landing page and documentation home are read in either
  language
- **THEN** none of them reads "Download for Linux (AppImage)" or 「下載 Linux 版（AppImage）」, nor names
  `AppImage` or `dmg` as the only download

### Requirement: Product-specific parts follow the page's product

Everything on a page that belongs to one product SHALL be that of the page's product: the page title's site
suffix and `og:site_name`; the share image's alternative text; the home-screen icon; the source repository
and license links in the header and the footer. spekterm's platform status (builds for Linux and for macOS
on Apple Silicon; Windows and Intel Macs not yet) SHALL appear only on spekterm pages.

#### Scenario: A spek page carries nothing of spekterm's

- **WHEN** every spek page of the built site is read
- **THEN** its title ends with "spek", its `og:site_name` is "spek", its `og:image:alt` is spek's, its
  home-screen icon is spek's and the built site contains it, it does not contain spekterm's platform
  status, and no header or footer link targets `https://github.com/spekhq/spekterm` or anything under it

#### Scenario: A spekterm page links to its own repository

- **WHEN** every spekterm page of the built site is read
- **THEN** its header and footer repository links target `https://github.com/spekhq/spekterm`
