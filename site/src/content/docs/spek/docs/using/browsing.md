---
title: Browsing
description: spek's views — dashboard, specs, changes, schemas, graph, timeline — and search.
sidebar:
  order: 1
---

Every form of spek has the same navigation: **Overview**, **Specs**, **Changes**, **Graph**, **Schemas**,
and **Timeline**, plus search.

## Overview

The dashboard counts specs, active changes, and archived changes. It also shows task completion, the
average lifecycle of archived changes, and how many active changes are stale (created more than 30 days
ago). Below that come the active changes with their task progress, then the recently archived ones.

## Specs

Every spec appears in a folder tree, nested as `openspec/specs/` is on disk, with a filter. A spec opens
as an outline: requirements and scenarios fold in place, and the normative keywords (SHALL, MUST) and the
scenario steps (WHEN, GIVEN, THEN, AND) are highlighted. Each spec also has a history: the changes that
touched it, newest first.

## Changes

Active and archived changes. Each row shows the change's creation date and lifecycle, and an archived
change's row also shows its archive date. A change opens with one tab per artifact it contains (proposal,
design, tasks, specs, and so on). The tabs can be ordered by last modified, by the order the workflow schema
defines, or A–Z. Delta specs carry a badge for each operation (ADDED, MODIFIED, REMOVED, RENAMED); task
lists show their checkboxes, with progress per section.

## Graph

How specs and changes relate: each change links to the specs its deltas touch.

## Schemas

Every workflow schema the repository can use, with its source and the artifacts it defines. A schema
opens as a flow that lists each artifact in dependency order, with the file it produces, what it needs
before it can be written, and its instructions. The repository's default schema is marked, and each schema
links to the active changes that use it.

## Timeline

Every change's lifecycle on a horizontal, Gantt-style chart: archived changes are bars from creation to
archive, and active ones run to today. You can group changes by spec topic, and hide the active or the
archived ones.

## Search

`Ctrl+K` (`Cmd+K` on macOS) searches the text of every spec and change.

## Theme

spek has a dark and a light theme; the button in the header switches between them.
