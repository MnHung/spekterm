## Why

The companion Android app is to let the user browse their workspace's OpenSpec from the phone — active and
archived changes, a change's artifacts, the main specs — and the protocol it is built against does not yet
describe that well enough to build it. The four read-only operations exist (`openspec.changes`,
`openspec.change`, `openspec.specs`, `openspec.spec`), but their results are documented as "as the side panel
lists them" and "…": they hand over whatever the desktop's OpenSpec service returns, including fields that only
mean something on the desktop, and any field `@spekjs/core` adds later reaches the phone without anyone deciding
it should. A client cannot be written from that, and the phone UI is the next handoff (to spekterm-android).

Measured on this repository's own `openspec/` (1 active and 84 archived changes, 58 specs) and on a fixture
repository with a linked worktree outside the folder:

- No result carries an absolute path today: the service already strips core's worktree `source` and turns
  `SpecInfo.path` into a folder-relative path. That holds by the service's construction, not by anything the
  protocol states or checks — `ChangeSummary` is `Omit<ChangeInfo, 'source'>`, so every other core field flows
  through as it appears. An error answer does carry one: a read failure's message is the file system error's text,
  absolute path included, sent to the device as is.
- The change list is 34 KB (4 KB deflated). One change with all its artifacts is 60 KB at the median, 132 KB at
  the 90th percentile and 213 KB at most (62 KB deflated); the largest spec is 93 KB. A change's tasks artifact
  is sent twice over — the raw `tasks.md` and the parsed task list.
- Changes in worktrees are aggregated and listed once per slug (core elects one copy of a slug that several
  working trees hold), so a slug identifies a change within a folder.
- The server caps what a client sends at 1 MiB per frame; nothing bounds what it sends.
- Desktops 0.2.5 to 0.2.7 are released with these four operations passing the views through. A client must be able
  to tell what it is talking to.

## What Changes

- **The four results get pinned, protocol-owned shapes** — fields named in `docs/remote-protocol.md`, built by
  an explicit mapping in the remote host, not the service's views passed through. A field core or the side panel
  adds later does not reach a device until the protocol names it. Field names stay those of today's results, so a
  client reads an older desktop's answers with the same parser.
  - **BREAKING (on paper)**: fields that only serve the desktop are dropped — every folder-relative file path
    (`relPath`); in a change's listing `date`, `artifactCount`, `schema` and `defaultSchema` (and the list's own
    `defaultSchema`); in a change `schema`, `defaultSchema`, `schemaOrder` and `missingArtifacts`; the raw text of
    the tasks artifact; a spec's `relatedChanges` (the same slugs as its `history`); and the worktree's `key`,
    `vcs` and `isFolderRoot`. No client reads these operations yet (spekterm-android does not call them), so nothing
    breaks; the protocol's "grows only by additions" rule applies from here on.
- **Artifacts arrive in the side panel's order**, sorted by the desktop, so no client reimplements it.
- **A change's worktree is shown, not addressed.** A change stays identified by its slug; when the repository has
  more than one working tree, each change and spec states which one it is read from by branch and whether it is
  the main working tree.
- **One change is one answer**, with all its artifacts' content — the measured sizes do not justify a separate
  per-artifact fetch. Every OpenSpec answer is bounded instead: when an answer would exceed the frame cap, the
  largest pieces of content come without it, marked as omitted with their size, and the rest still reads.
- **A new operation, `openspec.watch { folderId? }`, and its event `openspec.changed { folderId }`**: a connection
  watches the one folder it shows and is told when that folder's OpenSpec changes on disk (an agent writing
  `tasks.md`), then reads again. Its presence in the authentication answer's operation list is also the signal
  that the desktop sends the pinned shapes.
- **No error answer carries a path**: an OpenSpec read failure is answered with a fixed message.
- **What a client must know about the content** goes into the document's client obligations: artifact, spec and task
  text is the repository's, untrusted; render markdown without raw HTML; a relative link is not a link (the
  desktop's side panel does the same); a `data` artifact (`.yaml`, `.yml`, `.json`) is shown as text.
- No new network API, no new dependency, and nothing in the desktop's side panel changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote-protocol`: the "OpenSpec content is readable and only readable" requirement gains the pinned result
  shapes, the guarantee that no path or desktop-only field reaches a device, the worktree statement, and the client
  obligation for OpenSpec content; "Operations are an allow-list with named errors" gains the watch (based on the
  main spec as `remote-close-offer`'s archive left it); new requirements add the answer bound
  and the folder watch with its event.

## Impact

- `src/main/remote-openspec.ts` (new) — the mapping from the service's views to the protocol shapes, and the bound.
- `src/main/remote-host.ts` — the four operations go through it; the read-failure message becomes fixed; the watch
  starts the folder's file watching.
- `src/main/remote-protocol.ts` — `openspec.watch` in the operation allow-list and the per-connection watched folder.
- `src/main/remote-service.ts` — the throttled `openspec.changed` to the connections watching that folder.
- `src/main/index.ts` — the remote host's own `OpenSpecService` gets a change callback (today a no-op), and is told
  when a folder leaves the workspace (today it keeps watching it).
- `src/main/remote-frames.ts` / `remote-server.ts` — the frame cap becomes one shared constant.
- `src/main/openspec-service.ts` — read only; no change expected.
- `docs/remote-protocol.md` — section 2's frame cap, section 5's four operations and the watch, section 9's
  obligations.
- Tests: `remote-openspec.test.ts` (new), `remote-host.test.ts`, `remote-protocol.test.ts`,
  `remote-service.test.ts`, `scripts/probe-remote.mjs`, `scripts/scenario-coverage.test.mjs`.
- Website: none — the remote access page only says the phone can read your OpenSpec, which stays true; the "Data
  and network" page is untouched. `scripts/network-surface.test.mjs` gains one module allow-list entry,
  `@spekjs/core/artifact-order` (a pure sort the main process now imports; no network).
- Follow-up outside this repository: the phone UI, as a handoff to spekterm-android once this is approved.
