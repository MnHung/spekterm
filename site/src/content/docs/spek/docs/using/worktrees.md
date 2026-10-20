---
title: Worktree aggregation
description: How spek shows the changes of every git worktree of a repository, and jj workspaces as an experimental option.
sidebar:
  order: 2
---

A repository often has several working copies at once: each agent, or each parallel task, works on its own
branch in its own git worktree. The OpenSpec changes for that work are spread across those copies, so a
viewer pointed at one of them sees only part of it.

spek finds every worktree of the repository (with `git worktree list`) and shows their in-flight changes in
one list:

- **Changes from every worktree**, each tagged with the branch it comes from. Changes from the main
  worktree carry no tag, so the feature work stands out.
- **One change, one row.** A change that several worktrees inherited is shown once. Which copy is shown is
  decided from git (the worktree whose commits or uncommitted edits moved it past the main branch), not from
  file times.
- **Archived changes** from every worktree, merged.
- The list refreshes when any worktree's `openspec/` changes.

Point spek at any worktree, or at the main checkout: the result is the same.

## The scope control

When there is more than one working copy, the header shows a scope control with **Current dir** and
**Worktrees**, plus **Worktrees + jj** when a jj workspace is detected. spek remembers the choice: the web
app keeps it in the browser's storage, and VS Code keeps it in the `spek.aggregateWorktrees` and
`spek.aggregateJjWorkspaces` settings.

## jj workspaces (experimental)

In a repository that uses both git and [jj](https://jj-vcs.github.io/jj/), jj workspaces are invisible to
`git worktree list`. Choose **Worktrees + jj** (or set `spek.aggregateJjWorkspaces` in VS Code) and spek
also scans every jj workspace:

- Off by default, and offered only when a jj workspace exists.
- Identical copies of a change collapse into one row. A workspace whose copy has diverged keeps its own
  row, marked as conflicting. The change a workspace is currently editing is marked *editing*.
- jj is never required. Without jj, or with the option off, spek works as if this feature did not exist.

## Where it works

The web app and the VS Code extension aggregate worktrees. The JetBrains plugin does not.
