---
title: GitHub Action and badges
description: Build a static spek page of your repository's OpenSpec in CI, deploy it to GitHub Pages, and add status badges.
sidebar:
  order: 3
---

The [spek action](https://github.com/marketplace/actions/spek-openspec-static-site) runs in your own GitHub
Actions and builds a single, self-contained HTML page of your repository's OpenSpec. The page has the same
views as the other forms, with the content embedded in it. The action can also write status badges.

## Basic use

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0  # full history, for the changes' dates

- uses: spekhq/spek@v1
  with:
    title: "My Project - OpenSpec"
```

Without the full git history the build still succeeds; the changes' dates are then unavailable.

## Deploy to GitHub Pages

```yaml
name: Build OpenSpec Site
on:
  push:
    branches: [main]
    paths: ["openspec/**"]

permissions:
  pages: write
  id-token: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - uses: spekhq/spek@v1
        with:
          title: "My Project - OpenSpec"

      - uses: actions/upload-pages-artifact@v5
        with:
          path: spek-output

      - name: Deploy to GitHub Pages
        id: deploy
        uses: actions/deploy-pages@v5
```

## Inputs and outputs

| Input | What it does | Default |
|---|---|---|
| `repo-path` | The directory that contains `openspec/` | `.` |
| `output-path` | Where to write the page | `spek-output/spek.html` |
| `title` | The page's title | `OpenSpec Viewer` |
| `spek-version` | Which spek source to build with: a tag, branch, or commit | `master` |
| `generate-badges` | Also write the status badges | `false` |

| Output | |
|---|---|
| `html-path` | The page's absolute path |
| `badges-path` | The badges directory's absolute path |

`spekhq/spek@v1` selects the action. `spek-version` selects the spek source the action builds the page
with, and defaults to spek's main branch. To build with a fixed release, set `spek-version` to one of the
tags on [spek's releases page](https://github.com/spekhq/spek/releases).

## Badges

With `generate-badges: true`, the action also writes three SVG badges next to the page: the number of
specs, the number of open changes, and task progress. The action draws them itself and calls no badge
service. Deploy them with the page and reference them from your README:

```markdown
![Specs](https://your-user.github.io/your-repo/badges/specs.svg)
![Open Changes](https://your-user.github.io/your-repo/badges/open_changes.svg)
![Tasks](https://your-user.github.io/your-repo/badges/tasks.svg)
```

## What runs

The action runs in your workflow. It checks out spek's source at `spek-version`, installs spek's
dependencies and the OpenSpec CLI from npm, and builds the page with the CLI's usage statistics turned off.
See [Data and network](/spek/docs/reference/data-and-network/).
