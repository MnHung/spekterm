---
title: Install spek
description: Install spek in VS Code or a JetBrains IDE, or run the web app from its source.
sidebar:
  order: 1
---

spek reads any repository that has an `openspec/` directory. Each form below shows the same views
([Browsing](/spek/docs/using/browsing/)). The [GitHub Action](/spek/docs/using/github-action/) is different:
it builds a static page in CI instead of running on your machine.

## VS Code

Install **spek — OpenSpec Viewer** from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=kewang.spek-vscode) (it is
also on [Open VSX](https://open-vsx.org/extension/kewang/spek-vscode)). It needs VS Code 1.85 or later.

- It turns on when the workspace's `openspec/` directory contains `config.yaml`, `specs/`, or `changes/`.
- The **spek** icon in the Activity Bar opens a sidebar that lists your specs (nested by folder) and
  changes. Click an item to open it in the full viewer panel.
- Commands: **spek: Open spek**, **spek: Search OpenSpec**, **spek: Open Dashboard**.
- Settings:

  | Setting | What it does | Default |
  |---|---|---|
  | `spek.aggregateWorktrees` | Show the changes of every git worktree of the repository | `true` |
  | `spek.aggregateJjWorkspaces` | Experimental: also show jj workspaces | `false` |

  The panel's scope control writes these settings, and editing the settings updates the control
  ([Worktree aggregation](/spek/docs/using/worktrees/)).

## JetBrains IDEs

Install **spek - OpenSpec Viewer** from the
[JetBrains Marketplace](https://plugins.jetbrains.com/plugin/30600-spek--openspec-viewer) — or search for
"spek" in **Settings › Plugins › Marketplace**. It works in IntelliJ IDEA, WebStorm, PyCharm, PhpStorm,
GoLand, RubyMine, CLion, Rider, and other IntelliJ-based IDEs, 2023.3 or later.

- It turns on when the project contains an `openspec/` directory.
- Open it from the **spek** tool window in the right sidebar, or **Tools › Open spek**.
- It renders inside the IDE when the IDE has an embedded browser (JCEF). Otherwise it opens the same page
  in your default browser.
- The plugin does not aggregate worktrees.

## Web app

The web app runs from spek's source; it is not published as a package. You need
[Node.js](https://nodejs.org/) 22 or later, and git.

```bash
git clone https://github.com/spekhq/spek.git
cd spek
npm install
npm run dev
```

Open `http://localhost:5173`, enter the path of a repository that contains an `openspec/` directory, and
browse. `npm run dev` starts two processes on your machine: the page on port 5173, and the API the page
reads from on port 3001 ([Data and network](/spek/docs/reference/data-and-network/)).

## The OpenSpec CLI

spek reads `openspec/` on its own. When the [OpenSpec CLI](https://github.com/Fission-AI/OpenSpec) is
installed, spek also asks it about the repository's workflow schemas. Without the CLI everything else still
works, but spek can show less about schemas.
