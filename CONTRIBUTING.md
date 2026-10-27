# Contributing to spekterm

Thanks for your interest in improving **spekterm** — a local, agent-first development workbench that
hosts one `claude` session per repository and puts an
[OpenSpec](https://github.com/Fission-AI/OpenSpec)-aware side panel next to it. Contributions of all
sizes are welcome, from typo fixes to new features.

If anything here is unclear or out of date, please open an issue — improving the contributor
experience counts as a contribution too.

## Code of Conduct

This project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are
expected to uphold it. Please report unacceptable behavior to **cpckewang@gmail.com**.

## Ways to contribute

- **Report a bug** — open a [bug report](https://github.com/spekhq/spekterm/issues/new/choose).
- **Request a feature** — open a [feature request](https://github.com/spekhq/spekterm/issues/new/choose).
- **Ask a question or float an idea** — open a blank
  [issue](https://github.com/spekhq/spekterm/issues/new/choose).
- **Send a pull request** — see [Submitting a pull request](#submitting-a-pull-request) below.
- **Report a security vulnerability** — do **not** open a public issue; follow
  [SECURITY.md](SECURITY.md).

## Getting started

### Prerequisites

- **Linux for development.** The end-to-end probes run only on Linux (they need `xvfb`), and `npm run dev`
  keeps its data apart from an installed spekterm only there. A Mac with Apple Silicon is needed only to
  package the macOS build (`npm run dist:mac`) and run its acceptance (`npm run probe:package:mac`); see
  [README](README.md#on-macos). There is no Windows build yet.
- **Node.js 22** — the exact version is pinned in [`.nvmrc`](.nvmrc) (`nvm use` picks it up).
- **[Claude Code](https://code.claude.com/docs)** (`claude` on your `PATH`) if you want
  to open agent sessions.
- **`xvfb`** (`sudo apt install xvfb`) to run the end-to-end probes — they run on a virtual display so
  they don't take over your screen.

### Setup

```bash
git clone https://github.com/spekhq/spekterm.git
cd spekterm
npm install
npm run dev          # electron-vite dev; settings live in ~/.config/spekterm-dev
```

`npm run dev` keeps its settings separate from an installed build (`~/.config/Spekterm`), so you can
run both side by side.

### Useful commands

```bash
npm run build          # Build to out/ (also generates the third-party license summary)
npm run typecheck      # Main / preload (node) + renderer (web)
npm run lint           # ESLint — there is no Prettier in this repo; don't run it
npm test               # Unit tests: headless, seconds, safe to run any time
npm run dist:linux     # Bump the version, build, and package an AppImage into release/
npm run install:desktop # Install the latest AppImage into your applications menu
```

## Testing

There are two layers, and the dividing line is **cost**:

| | What it is | When to run it |
| --- | --- | --- |
| `npm test` | `node:test` unit tests — headless, seconds, no side effects | **Any time.** After every change |
| `npm run probe:<name>` | End-to-end probes that drive the real app over the Chrome DevTools Protocol | When you change behavior in that area |
| `npm run test:e2e` | All probes in sequence (about twenty minutes) | Before a release |

Probes verify **the code that ships** — they never rely on test-only branches in product code, and the
UI carries no `data-*` hooks for them. They locate elements by `role` and `aria-label`, which are taken
from the English dictionary (`src/shared/i18n/en.json`).

`npm run probe:package` is a third tier: it packages a real AppImage and launches it. Because packaging
bumps the version and commits it, use `PROBE_PACKAGE_APPIMAGE=<path> node scripts/run-probe.mjs package`
to reuse an existing build while iterating.

## Project layout

| Path | What it is |
| --- | --- |
| `src/main/` | Electron main process: filesystem boundary, pty sessions, OpenSpec scanning, inbox, Slack, handoffs |
| `src/preload/` | The allowlisted bridge between renderer and main |
| `src/renderer/` | React UI: the rail, terminals, the side panel, dialogs |
| `src/shared/` | Code and dictionaries shared by both processes (i18n, lineage) |
| `scripts/` | Probes, guards (`*.test.mjs`), and build / release tooling |
| `openspec/` | Specs and change history — spekterm plans its own development with OpenSpec |
| `docs/` | Product requirements (`PRD.md`), the UI mockup, and `lessons/` |

**Before touching a module, read its lessons file.** [`CLAUDE.md`](CLAUDE.md) has a table
("踩雷指南") that maps each area — pty and sessions, the side panel, the inbox, Slack, handoffs, i18n,
probes — to a file under `docs/lessons/`. Those files record failures that were silent the first time;
they are prerequisites for their modules, not background reading.

## How we track changes: OpenSpec

spekterm uses **OpenSpec to plan its own development** — and its side panel renders that very
`openspec/` directory. For **non-trivial** changes (new features, behavior changes, anything worth a
design discussion) we create an OpenSpec change — a proposal, design notes, spec deltas, and tasks —
before implementing.

You're **not required** to author OpenSpec artifacts to contribute. A focused bug fix or a docs tweak
can go straight to a pull request. If you're planning something larger, open an issue first so we can
agree on the approach (and, if appropriate, an OpenSpec change) before you invest the work.

## Coding conventions

- **English is the language of the repository.** Code, comments, `openspec/` artifacts, `docs/`,
  community files, and commit messages are written in English. Much of the existing documentation and many comments are in
  Traditional Chinese — no need to translate those wholesale, but **write new ones in English**. The
  README is the one bilingual exception (`README.md` + `README.zh-TW.md`).
- **User-visible text always comes from the dictionaries** in `src/shared/i18n/` (`en.json` and
  `zh-TW.json`) — never a string literal in a component. A guard test rejects CJK string literals and
  hard-coded `aria-label`s in product code.
- **Keep private details out of the repo** — no personal home-directory paths, no names of your
  employer's internal systems or colleagues. Use generic examples (`/home/me`, `api-server`, `@alex`).
- Match the style of the surrounding code: its naming, comment density, and idioms.

## Submitting a pull request

1. **Fork** the repo and create a branch from `master`.
2. Make your change. Keep the PR focused — one logical change per PR is easier to review.
3. **Run the checks locally:**
   ```bash
   npm test
   npm run typecheck
   npm run lint
   npm run build
   npm run measure:bundle
   ```
   CI runs the same checks on every push and pull request. It does not run the probes — if you
   changed behavior covered by a probe, run that probe yourself (`npm run probe:<name>`).
4. **Fill out the pull request template** — it prompts for the affected area, a summary, and a short
   checklist.
5. Open the PR against `spekhq/spekterm:master` and link any related issue (`Fixes #123`).

### What maintainers handle for you

- **Version bumps and releases.** You don't need to bump the version in your PR — packaging bumps it
  and commits the bump itself.

  For maintainers, a release goes in this order: `npm run dist:linux` (bumps, commits and packages),
  `npm run install:desktop`, push, then `npm run release:github -- --notes-file <notes.md>`. The last step
  creates the `v<version>` release as a draft with the AppImage **and** `release/latest-linux.yml`, and
  publishes it only once both are uploaded. Linux installs update themselves from that file, so a release
  must never be made by hand without it. Run the same command on the build Mac after `npm run dist:mac` to
  add the dmg to the existing release. Instead of the build Mac, the dmg can come from the `macOS dmg`
  workflow (`.github/workflows/mac.yml`), which builds and accepts it when the release is published: put the
  dmg from a green run into `release/` of a checkout of the release commit and run the same command.
  Packaging never publishes anything by itself (`--publish never`).

### Review

Maintainers review for **correctness** and whether the change does what it claims. We won't hold a PR
against undocumented internal conventions — if a convention matters, it belongs in this file or in
`CLAUDE.md`, so tell us if you hit one that isn't written down.

**If a PR grows, we may ask you to split it.** One logical change per PR reviews and lands faster.

## License and sponsorship

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.

If the maintainer accepts sponsorship (for example through GitHub Sponsors), it supports the
**maintainer personally**. It is not a shared project fund, and sponsorship income is **not distributed
based on contributions**; contributing does not create any claim to it.
