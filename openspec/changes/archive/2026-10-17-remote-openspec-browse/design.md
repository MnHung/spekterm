## Context

See proposal.md for why. The state this design starts from, all read from the code or measured:

- `src/main/remote-host.ts` answers the four operations by calling the desktop's `OpenSpecService` and returning
  its view objects unchanged. `openspecCall` maps `UNKNOWN_FOLDER`/`NOT_FOUND` → `NOT_FOUND` and `READ_FAILED` →
  `INTERNAL` **with the service's message**, which for a read failure is `String(error)` of a file system error —
  an absolute path (measured: an unreadable `design.md` answers
  `INTERNAL | Error: EACCES: permission denied, open '/…/openspec/changes/x/design.md'`).
- The host has **its own** service instance (`src/main/index.ts`, created on the first read, disposed when remote
  access is turned off) whose change callback is a no-op — but it watches every folder it has scanned, worktrees
  outside the folder included, like the side panel's instance. A file event invalidates the scan cache at once and
  calls back 150 ms after the first event of a burst, so a read after the callback sees the new content. The
  instance is **never** told when a folder leaves the workspace: `releaseFolderOpenSpec` releases only the
  renderer's instances (`ipc/folders.ts` → `ipc/openspec.ts`).
- The service's views were built for the renderer. `ChangeSummary` is `Omit<ChangeInfo, 'source'> & { worktree? }`
  on purpose, so that core's new fields reach the side panel with no work (`docs/lessons/side-panel.md`). The same
  property is what a network contract must not have.
- Measured payloads (scratch scripts that drive `OpenSpecService` directly; this repo, and a fixture repo with a
  linked worktree outside the folder):

  | | raw | deflated |
  |---|---|---|
  | `openspec.changes`, 85 changes | 34 KB | 4 KB |
  | `openspec.change`, median / p90 / max of 85 | 60 / 132 / 213 KB | max 62 KB |
  | `openspec.specs`, 58 specs | 6 KB | 1 KB |
  | `openspec.spec`, largest | 93 KB | 30 KB |

  In the largest change, the tasks artifact is 52 KB, of which the raw text is 14 KB and the parsed list 27 KB; the
  spec deltas are 87 KB. No string in any result's metadata contains the folder's or the worktree's absolute path.
- Core lists one copy per slug: active changes go through its divergence election (a working tree that moved the
  change forward or holds uncommitted edits wins over the main tree, mtime breaks ties), archived ones come from
  the main working tree first (`scanner.js`, `pickActiveWinners` / `archivedBySlug`). jj is off
  (`includeJj: false`). An active slug is a directory name and an archived one carries a date prefix, so the two
  lists do not share slugs. A spec's `relatedChanges` and its `history` are built from the same list (`readSpec`),
  and every `history` slug is readable as a change (core always scans the main tree).
- Core's change `timestamp` is the author date of the **earliest** commit touching `openspec/changes/<slug>/` (or
  `archive/<slug>/`) in that working tree's history, cached per working-tree path in module-level state shared by
  every service instance in the process, and never refreshed (`git-cache.js`): a later commit does not change it,
  and a change first committed after that working tree was first scanned in this process stays `null` until the
  desktop restarts. `git log --name-only` lists a rename under its new path only, so an archived change's
  `timestamp` is **the archiving commit's** time, not when the change began (in this repository active change
  directories are never committed, so every archived change's value is its archive day). Lists are sorted by one
  key, `timestamp` or else the slug's date, compared as strings in descending order (`scanner.js`); a change with
  neither — an uncommitted active one — is last. The strings carry their own UTC offsets, so across time zones the
  string order is not strictly the time order.
- The server limits client frames to 1 MiB (`MAX_PAYLOAD`, not exported, `ws`'s `maxPayload` only limits incoming
  frames); it sends whatever it is given. A request `id` is at most 64 characters (`remote-frames.ts`).
- Desktops 0.2.5–0.2.7 are released with the four operations passing the views through, and list the same four
  in `operations`.
- The desktop's side panel renders a relative link in an artifact as plain text (`MarkdownView.tsx`), shows a tasks
  artifact only as its parsed list (`ChangeView.tsx`), and orders artifacts with core's
  `sortArtifacts(…, 'schema', schemaOrder)` in the renderer. Core's own order is by mtime, newest first, with
  `DEFAULT_ORDER` (proposal, design, specs, tasks) on ties.

## Goals / Non-Goals

**Goals:**

- A client can be written from `docs/remote-protocol.md` alone: every field of the four results named, typed, and
  said when it is absent.
- What reaches a device is decided by the protocol, by construction, so a path or a desktop-only field cannot slip
  through when core or the side panel grows — in answers and in error messages.
- No OpenSpec answer can exceed what a client can be told to accept.
- A client can tell a desktop that sends these shapes from one released before them, and still read the older one.

**Non-Goals:**

- Writing OpenSpec from a device (continuation, ticking a task). The requirement stays "only readable".
- A spec as it was at a change (`getSpecAtChange`), the graph and the timeline.
- Choosing a worktree from the phone, or showing a worktree's own copy of a main spec. The phone sees what the
  side panel's aggregated listing sees.
- Fixing core's `timestamp` (earliest commit, cached per process). The protocol documents it as it is.
- Changing the side panel or `OpenSpecService`.

## Decisions

### D1. The results are built by an allow-list mapping in its own module

A new pure module, `src/main/remote-openspec.ts`, turns the service's views into the protocol's shapes by naming
each field it copies. `remote-host.ts` calls it.

- **Over stripping known-bad fields from the views** (a deny-list): the views grow whenever core or the side panel
  needs something, and a deny-list says nothing about the next field. This repo's general lesson — "not accepting
  something is guaranteed by structure, not by nobody sending it" — applies directly (`SessionStore.replace()`'s
  whitelist is the precedent).
- **Over changing `OpenSpecService`'s views**: they are the renderer's, and their pass-through of core's fields is
  deliberate there.
- **Over defining the shapes as TypeScript types only**: a type does not stop a spread. The mapping copies field by
  field, and its unit test feeds it views carrying extra fields (including an absolute path) and asserts the output
  has exactly the documented keys.

**Every kept field keeps today's name and place**, so an older desktop's answer is a superset a client parses with
the same code (see D5 for telling them apart). The shapes (the document states them; this is the decision, not the
wording):

- `openspec.changes` → `{ active: [Change], archived: [Change] }`, each list in the desktop's order. `Change`:
  `{ slug, status, description, createdDate, archivedDate, timestamp, hasProposal, hasDesign, hasSpecs, hasTasks,
  taskStats: { total, completed } | null, worktree? }`. Dropped: `date` (the slug's date prefix, already
  `archivedDate` for an archived change), `artifactCount`, `schema`, `defaultSchema` and the list's `defaultSchema`
  (the desktop uses the last ones to decide whether to show a schema badge).
- `openspec.change` → `{ slug, status, createdDate, archivedDate, worktree?, artifacts: [Artifact] }`, artifacts
  **in display order** — the host applies core's `sortArtifacts` (`@spekjs/core/artifact-order`, node-free; the
  main process already imports the `graph-node-id` subpath the same way). `Artifact`: `{ id, title, kind }` plus,
  by kind:
  - `markdown`, `data`: `content` (the file's text);
  - `tasks`: `tasks: { total, completed, sections: [{ title, tasks: [{ text, completed }] }] }` — the parsed list
    only, as the side panel shows it; the raw `content` is dropped (it doubled the artifact);
  - `specs`: `specs: [{ topic, content }]`, one per delta spec.
  Dropped: every `relPath`, `schema`, `defaultSchema`, `schemaOrder` (consumed by the ordering), `missingArtifacts`
  (it drives the desktop's continuation entry, which a device does not have).
- `openspec.specs` → `[{ topic, relatedChangeCount }]` in the desktop's order. Dropped: `relPath`.
- `openspec.spec` → `{ topic, content, history: [{ slug, status, description, date, timestamp }], origin? }`.
  Dropped: `relPath`, and `relatedChanges` (the same slugs as `history`, by construction).
- A change's `worktree` and a spec's `origin`: `{ branch: string | null, isMain: boolean }`. Dropped: `key` (not
  needed to address anything — see D3), `vcs` (always git while jj is off), `isFolderRoot` (a desktop capability
  test).
- `timestamp` (in `Change` and in `history`) is documented as it is: the time of the first commit that touched the
  change's directory — for an archived change, the commit that archived it; `null` when there is none **or the
  commit came after the desktop first read that working tree**; not updated while the desktop runs. The order is
  documented with it: one key, `timestamp` or else the slug's date, newest first by string comparison, changes with
  neither last. A client that wants "when it began" or "most recently worked on" cannot get either from this field,
  and the document says so; `createdDate` (from the change's own `.openspec.yaml`) is the start date where present.

### D2. No path reaches a device: by construction for answers, by a fixed message for errors, checked on a real payload

- **Errors.** `INTERNAL` from an OpenSpec read carries a fixed message ("the OpenSpec content could not be read");
  the service's message goes to the main process's log only. `NOT_FOUND` messages stay — they name only the
  identifier the device sent.
- **The check.** The probe reads all four operations from a fixture whose linked worktree sits **outside** the
  folder, and asserts that no string in the results contains the folder's path, the worktree's path, the probe's
  stub home or the real home directory — except repository-authored text, which may legitimately contain anything:
  `content`, task `text`, section `title`. Names (`slug`, `topic`, a data artifact's `title`, which core sets to its
  file name) are checked like everything else; a path cannot appear in them because they are single directory or
  file names. The fixture's worktree must really be aggregated — a probe prerequisite asserts a change listed with
  `worktree.isMain === false` — because core silently falls back to the plain scan when there is only one working
  tree, and every path assertion would then pass for the wrong reason (`docs/lessons/side-panel.md`).

### D3. A change is addressed by slug; its worktree is a label

Core guarantees one listed copy per slug, and `OpenSpecService` resolves the read root from that copy. A device
therefore needs nothing but `{ folderId, slug }`, as today. `worktree` (`origin` for a spec) is present only when the
repository has more than one working tree — the rule the service already follows — and carries the branch and
whether it is the main tree, so the phone can label a change as the side panel does (the desktop labels only
non-main ones). A spec's `origin` is always the main tree; it is there so the phone can say whose copy it shows while
a worktree may hold a newer one.

- **Over addressing by `(worktreeKey, slug)`**: there is never a second copy to choose, and a key a device holds is
  one more value to keep valid across rescans.

### D4. One change is one answer, and every OpenSpec answer is bounded

The measured maximum is 213 KB raw and 62 KB on the wire with the permessage-deflate the server already offers — a
second or less on a slow mobile link, and a single round trip is better than one per artifact. So there is no
per-artifact operation. What the design adds is a bound, because nothing today stops one huge `data` artifact or
spec from producing a multi-megabyte frame:

- **The bound** is the 1 MiB frame cap, as UTF-8 bytes of the serialized result, less a 4 KiB reserve for the
  envelope (`{"t":"res","id":…,"ok":true,"r":…}` with a 64-character id, escaped, is well under 1 KiB). The cap
  becomes one exported constant in `remote-frames.ts`, used by `remote-server.ts` and by the bound; the pure module
  does not import `remote-server.ts`, which would load `ws`.
- **`openspec.change` and `openspec.spec`**: while the result is over the bound, the largest remaining content piece
  is replaced by `omitted: { bytes }`. The pieces are: an artifact's `content`, an artifact's `tasks`, each delta's
  `content` (so a delta becomes `{ topic, omitted }`), and the spec's `content`. `bytes` is the UTF-8 size of the
  piece's JSON serialization (for a string, its quoted, escaped form). Leaving a piece out saves a little less
  than `bytes` (the `omitted` object takes its place), so each step's saving is **computed exactly** — one property
  replaced by one, so no comma changes — and the result is measured again at the end; counting the saving as
  `bytes` would, with hundreds of small pieces, eat the reserve. (Re-serializing after every omission would be
  exact too, but costs a full serialization per piece.) Largest-first keeps the most pieces readable; ties go in display order so the result is deterministic. **If the
  result is still over the bound with every piece left out** (thousands of artifacts or history entries), the
  answer is `TOO_LARGE` with `detail.limit`.
- **`openspec.changes` and `openspec.specs`**: over the bound, the answer is `TOO_LARGE` with `detail.limit` (an
  existing error code). At the measured ~400 bytes per change, that needs about 2,600 changes in one folder;
  pagination is not worth designing for it.
- **Only OpenSpec answers are bounded by this change.** Section 2 says so, so a client does not cap every frame at
  1 MiB (a `conversation.watch` answer has no such bound).
- **Over a per-artifact fetch operation** (`openspec.artifact`): more operations, more round trips, and a second
  lookup path to keep consistent with the first — for sizes that do not need it.
- **Over a fixed per-piece limit**: simpler, but it does not bound the total — many medium pieces still add up.

### D5. `openspec.watch` scopes the change event to the folder a connection shows, and signals the new shapes

`openspec.watch { folderId? }` → `{}`. A connection watches at most one folder; watching again replaces it, and a
`folderId` that is absent or `null` stops watching; any other non-string is `BAD_PARAMS`. An unknown folder is
`NOT_FOUND`. When the host's service reports that folder changed, the remote service sends
`{ "t": "evt", "k": "openspec.changed", "d": { "folderId" } }` to the connections watching it. The event carries no
content; the client reads again what it shows. The watch ends with the connection.

- **The host half.** `RemoteHost` gains `openspecWatch(folderId)`, implemented in `remote-host.ts` by asking the
  host's service to scan the folder (any read does; the scan is what creates its file watching) through the same
  `openspecCall` error mapping as the reads: `UNKNOWN_FOLDER` → `NOT_FOUND`, `READ_FAILED` → the fixed `INTERNAL`
  message. **The answer waits for the scan**: the watchers of the other working trees are created only when the
  scan resolves (`#syncWorktreeWatches`), so answering earlier would leave a window in which a worktree's write is
  not seen, and a failed scan would be an unhandled rejection. The protocol handler records the watched folder only
  after the host succeeded.
- **The document tells a client to watch before it reads.** An event reaches only connections watching at the
  moment it is sent, so a change between a read and a later watch would go unannounced. A worktree created later is
  watched from the next scan, which a read causes — another reason to read again on every event.

- **Why an operation, over an event to every connection.** Desktops 0.2.5–0.2.7 list the same four OpenSpec
  operations and send the views as they are, with no event. A client needs a signal it can see, and the protocol's
  existing one is the authentication answer's `operations` list. **`openspec.watch` being listed is the signal**:
  that desktop sends the pinned shapes, sorts artifacts, bounds answers, and sends `openspec.changed`. Without it, a
  client still reads the four results with the same parser (D1 kept every name), offers manual refresh only, and
  shows artifacts in the order they come. The document says this in the operations' section. The watch also keeps
  the event off connections that are not showing the folder, which the broadcast version could not.
- **Over comparing `server.version`**: it couples every client to desktop release numbers, and a development
  build's version says nothing.
- **Over pull-to-refresh only**: the use this was asked for is following an agent's progress (`tasks.md` filling in)
  from the phone; pull-only makes that a manual loop.
- **Over pushing the new content**: sizes (D4).
- **Throttle: at most one event a second per folder, and every change followed by one within a second.** The first
  change after a quiet period starts a one-second timer; changes while it runs are absorbed; when it fires, one
  event goes out. A burst shorter than a second yields one event; a continuous stream yields one a second; the
  last change is never left unannounced. The service's own 150 ms debounce starts on a burst's first event and
  so calls back several times a second while an agent keeps writing, which is what this bounds — each event can
  make a phone re-read a 200 KB change. Folders are throttled independently; a change for a folder no connection
  watches starts no timer; timers are cleared when the remote service stops. The interval is injectable, as the
  reconcile interval already is (`reconcileMs`), so the tests do not wait seconds per case.
- **A folder that leaves the workspace** is released from the host's service (`releaseFolder`), as the renderer's
  instances are, and the remote service cancels that folder's pending timer, so no event for it follows — not even
  the one a running timer would have sent. The folder store's `subscribe` reports no difference (it fires on every
  save: add, reorder, pin), so `index.ts` keeps the previous set of folder ids and releases those missing from the
  new one. Today the host's instance keeps watching a removed folder until remote access is turned off.
- The `openspec.changed` event is described inside `openspec.watch`'s section of the document, not under a heading
  of its own: `scripts/remote-protocol-doc.test.mjs` reads every `` ### `name` `` heading as an operation. Section 6's
  "list events always carry the complete current value" stays true because this is not a list event.

### D6. What a client must know about content becomes an obligation

Section 9 gains one obligation, mirroring how the desktop treats the same text:

- Artifact, delta spec and spec content, and task and section text, are the repository's text: untrusted. Render
  markdown with raw HTML shown as text, never interpreted.
- A relative link or image reference resolves to nothing on the phone (the desktop shows a relative link as text).
  Open an `http(s)` link only on the user's tap, outside the app. Do not load remote images automatically.
- A `data` artifact is shown as plain monospace text; a task's `text` is markdown and may span several lines (core
  folds continuation lines into it).
- A piece marked `omitted` is shown as not available on the phone, with its size.

### D7. The allow-list delta is based on the main spec as `remote-close-offer` left it

The delta modifies "Operations are an allow-list with named errors" to add the watch. `remote-close-offer` modified
the same requirement (it added "keeping a session whose agent offered to close it"); it has since been archived
(`2026-10-17-remote-close-offer`) and synced into the main spec. This delta's copy is the synced main spec's
requirement with one line changed — checked line by line after the sync.

### D8. Verification

- `remote-openspec.test.ts` (unit):
  - exact key sets of each shape from views with extra fields;
  - artifacts sorted by a `schemaOrder` that differs from both the input order and `DEFAULT_ORDER`;
  - the largest-first omission, its determinism, a delta omitted as `{ topic, omitted }`, `bytes` equal to the
    piece's serialized size;
  - `TOO_LARGE` for an over-size list and for a change still over the bound with everything omitted;
  - many small pieces, where counting each saving as the piece's full size would overshoot the bound and the exact count does not.
- `remote-host.test.ts`: an answer goes through the mapping; a `READ_FAILED` carrying a path answers `INTERNAL` with
  a message that does not contain it; `openspecWatch` answers `NOT_FOUND` for an unknown folder and the fixed
  `INTERNAL` for a failed scan.
- `remote-protocol.test.ts`: `openspec.watch` replaces and stops a connection's watch, refuses an unknown folder
  without recording it, and answers `BAD_PARAMS` for a non-string, non-null `folderId`.
- `remote-service.test.ts`, with a short injected interval: the throttle (one event for a sub-second burst, one per
  interval for a stream, an event after the last change, folders independent); delivery only to connections
  watching that folder, including one that moved from F to G receiving nothing for F; a folder released while its
  timer runs produces no event.
- `scripts/probe-remote.mjs`, a `runOpenSpec` with its **own** git fixture (the shared `makeRepos()` serves 19
  sections): a linked worktree outside the folder holding an active change; the change's artifact files' mtimes set
  in the reverse of display order, so that core's mtime order and the display order differ. It checks key sets,
  display order, the worktree label (branch, `isMain: false`), a single-worktree folder's results carrying no
  label, no path in metadata (D2) with its aggregation prerequisite, the worktree's change read by slug, and
  `openspec.changed` after the probe writes that change's `tasks.md` **in the worktree** (the second watch layer).
  The watchers become ready a moment after they are created (chokidar, `ignoreInitial`), so the write is repeated
  with `retryAction` until the event arrives, never preceded by a fixed delay (`docs/lessons/probes.md`). The
  existing "a path-shaped identifier is not found" check stays in the section.
- `scripts/scenario-coverage.test.mjs`: the change's scenarios registered with their carriers.

## Risks / Trade-offs

- [A field the phone would want is added to core or the side panel and does not reach it] → Intended: the protocol
  names it in a later change. The cost is one mapping line and a document line.
- [Dropping fields is a removal, which protocol version 1 promises not to make] → No client reads these operations
  (spekterm-android's `app/src/main` has no call to them). An older desktop's answers are supersets of the new
  shapes, so a client parses both; `openspec.watch` tells them apart.
- [`timestamp` is the first commit, frozen per process] → Documented as it is, with the order it produces. A client
  cannot show "recently worked on" from it; fixing that is core's (`git-cache.js`), not this protocol's.
- [An answer is shaped to fit by omitting content] → In this repository nothing comes close (max 213 KB of 1 MiB);
  the omission is a guarantee for the outlier, and it says what was left out and how big it was.
- [A spec shown from the main working tree while a worktree has edited it] → The spec carries `origin` so the phone
  can say whose copy it is, as the side panel does; showing the worktree's copy is a non-goal.
- [A watch's file watching outlives the connection] → The host's service keeps a folder watched after its last
  watcher leaves, as it does for reads today; it ends when the folder leaves the workspace or remote access is
  turned off. Releasing per connection would trade a few idle watchers for rescans on every reconnect.

## Migration Plan

None. The four operations keep their names and parameters; no client reads them yet. Rollback is reverting the
commit.
