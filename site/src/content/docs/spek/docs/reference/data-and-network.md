---
title: Data and network
description: What spek reads, which programs it runs, and what each form connects to.
sidebar:
  order: 1
---

spek has no account, no telemetry, and no analytics of its own. It reads OpenSpec files and git history,
and never writes to your repository. What it connects to depends on the form.

## Where each form reads your repository

| Form | Reads |
|---|---|
| VS Code extension, JetBrains plugin, web app | The repository on your machine |
| GitHub Action | The repository checked out in your GitHub Actions runner |
| Static page (the action's output, the live demo) | A snapshot embedded in the page when it was built |

## Connections

| | Font from Google Fonts | Remote `https:` images in rendered Markdown |
|---|---|---|
| Web app | Yes | Loaded |
| Static page (action output, live demo) | No — the font is embedded in the page | Loaded |
| VS Code extension | No | Blocked (the panel's content security policy) |
| JetBrains plugin | No | Loaded |

Apart from these, the forms that run on your machine send no request to any outside host. The GitHub
Action is covered below. Links you open go to your browser.

## The web app's local server

`npm run dev` starts two processes on your machine: the page on port 5173, and the API the page reads from
on port 3001. Both listen only on this machine, the page on `localhost` and the API on `127.0.0.1`, so no
other device on your network can reach either. The API answers only the app's own page. It refuses any
request addressed to another host name, and any request from another web page or site, so a page you have
open in the same browser cannot read through it. The API reads two things: the folders you browse while
picking a repository (it lists them for the picker), and the OpenSpec content and git history of the
repository you open.

The JetBrains plugin serves its page through the IDE's built-in server, and it too answers only that
page.

## Programs spek runs

| Program | When | Forms |
|---|---|---|
| `git` | To date specs and changes from history, list worktrees, and decide which worktree advanced a change | Web app, VS Code, GitHub Action |
| `jj` | Whenever jj is installed, to detect jj workspaces — whether or not jj aggregation is turned on | Web app, VS Code |
| `openspec` | When installed, to read the repository's workflow schemas | Web app, VS Code, JetBrains, GitHub Action |

The OpenSpec CLI sends anonymous usage statistics unless you turn them off, and spek runs it with your
environment unchanged. To turn them off:

```bash
openspec config set telemetry.enabled false
```

The GitHub Action runs the CLI with its usage statistics already turned off.

## The GitHub Action

The action runs in your own GitHub Actions. It checks out spek's source at `spek-version` (spek's main
branch unless you set it), installs spek's dependencies and the OpenSpec CLI from npm, and builds the page.
The action draws the badges itself and calls no badge service.
