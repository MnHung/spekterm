## MODIFIED Requirements

### Requirement: Operations are an allow-list with named errors

An authenticated connection SHALL be able to invoke only the operations this capability names. Any other
operation SHALL be answered with an error naming it as unknown and SHALL have no effect. Every failure SHALL
be answered with a stable error code and a message. The connection SHALL stay open after an operation
fails.

The operations are:

- listing folders and sessions;
- watching a session's conversation, replying to it (with attachments, see `remote-attachments`), and
  answering its open prompt;
- uploading an attachment (see `remote-attachments`);
- watching a session's terminal output, and sending it input;
- creating a session;
- waking a dormant session;
- renaming a session;
- hibernating a running session;
- closing a session;
- keeping a session whose agent offered to close it (withdrawing the offer);
- listing, accepting and ignoring inbox items;
- reading handoff state and a handoff's brief;
- reading OpenSpec changes, change details and specs, and watching one folder's OpenSpec for changes;
- watching the attention stream, resuming from the last event received (see `remote-notifications`).

Writing or deleting files, changing settings, reading the Slack configuration, reading any credential, and
changing a terminal's size SHALL NOT be operations. The one exception to "writing files" is an uploaded
attachment. It is written only into the desktop's attachment store, under a name the desktop chooses
(`remote-attachments`). Closing a session removes that session's attachments, as closing it on the desktop
does. No operation SHALL take a path or a directory from the device.

#### Scenario: An unknown operation is refused without effect

- **WHEN** an authenticated client invokes an operation name that is not on the list, such as one that writes a file
- **THEN** the response is an error naming the operation as unknown, and the connection stays open

#### Scenario: A failed operation keeps the connection

- **WHEN** an authenticated client watches a session id that does not exist
- **THEN** the response is an error with a not-found code, and a following valid operation succeeds on the same connection

### Requirement: OpenSpec content is readable and only readable

A client SHALL be able to list a folder's OpenSpec changes, active and archived, and its specs, and read a
change's artifacts and a spec's content. The identifiers, lookup rules and errors SHALL be the same ones the side
panel uses, except for the error an answer over the frame cap produces. An identifier that is not in the folder's
scanned results SHALL be answered as not found without touching the file system. No operation SHALL change
OpenSpec content.

The four results SHALL contain exactly the fields the protocol document names for them, and no other: a field the
desktop's OpenSpec views or `@spekjs/core` gain later SHALL NOT reach a device until the protocol document names
it. No field the desktop derives SHALL carry a file system path, neither absolute nor relative to the folder, and no
result SHALL carry the desktop's internal identifier of a working tree. Text the repository's authors wrote
(artifact, spec and delta content, task text, section titles) and names taken from the repository (slugs, spec
topics, a data artifact's file name) are not derived and are sent as they are. No error answer to an OpenSpec
operation SHALL carry a path of the desktop's file system.

The results SHALL describe what the side panel shows:

- the changes the side panel lists, including those that live in other working trees of the folder's repository,
  each slug once and in the side panel's order;
- a change's artifacts in the order the side panel shows them, with a tasks artifact given as its parsed task
  list (sections, each task's text and whether it is completed) rather than its raw text;
- a spec's content as the side panel shows it, and the changes in its history, each of which can be read as a
  change.

A change SHALL be addressed by its folder and slug alone, wherever it lives. When the folder's repository has more
than one working tree, each change and each spec SHALL state the working tree it is read from by its branch and
whether it is the main working tree; with one working tree, they SHALL NOT state it.

The protocol document SHALL state when a change's timestamp is absent and that it does not change while the desktop
runs, and the order the change lists follow.

The protocol document SHALL require a client to treat artifact, spec, task and section text as untrusted: to render
markdown with raw HTML shown as text, never interpreted; to treat a relative link or image reference as resolving to
nothing; to open a web link only when the user taps it, outside the client; not to load a remote image
automatically; and to show a data artifact (YAML or JSON) as plain text. This repository has no carrier for that
obligation. It falls to the client.

#### Scenario: Reading a change's artifacts

- **WHEN** a client reads an active change of a folder that has OpenSpec
- **THEN** the response contains that change's artifacts with their content, in the order the side panel shows them

#### Scenario: A path-shaped identifier is not found

- **WHEN** a client reads a change whose identifier is a relative path that leaves the folder
- **THEN** the response is a not-found error

#### Scenario: A field the desktop adds does not reach a device

- **WHEN** the desktop's view of a change carries a field the protocol document does not name for that result
- **THEN** the result a client receives does not contain that field

#### Scenario: No path reaches a device from a repository with a worktree outside the folder

- **WHEN** a client lists and reads the changes and specs of a folder whose repository has a linked working tree
  outside the folder, holding an active change
- **THEN** no string in the results, other than text the repository's authors wrote, contains the folder's path, the
  working tree's path or the user's home directory

#### Scenario: A read failure does not reveal a path

- **WHEN** reading a change fails because one of its files cannot be read
- **THEN** the client receives an internal error whose message contains no path of the desktop's file system

#### Scenario: A change in another working tree is read by its slug and labeled with its branch

- **WHEN** a folder's repository has a linked working tree holding an active change, and a client lists the
  folder's changes and reads that change by its slug
- **THEN** the change is listed once, labeled with the working tree's branch as not the main working tree, and
  reading it returns the working tree's content

#### Scenario: A repository with one working tree labels nothing

- **WHEN** a client lists the changes of a folder whose repository has a single working tree
- **THEN** no change in the result states a working tree

#### Scenario: A tasks artifact arrives as its parsed task list

- **WHEN** a client reads a change that has a tasks artifact with completed and open tasks
- **THEN** that artifact gives each task's text and completion, grouped in its sections, and not the file's raw text

## ADDED Requirements

### Requirement: OpenSpec answers stay within the frame cap

No answer to an OpenSpec operation SHALL exceed the frame size the protocol document states for these answers
(1 MiB of UTF-8). The protocol document SHALL say that the bound applies to OpenSpec answers.

When reading a change or a spec would exceed it, the desktop SHALL leave out content, the largest piece first, until
the answer fits, and SHALL mark each piece left out with its size; everything else in the answer SHALL be as it
would have been. If the answer still exceeds the bound with all content left out, and when listing a folder's
changes or specs would exceed it, the answer SHALL be an error stating the limit.

#### Scenario: An oversized artifact is left out and the rest of the change still reads

- **WHEN** a client reads a change one of whose artifacts alone is larger than the frame cap
- **THEN** the answer fits the frame cap, that artifact is marked as left out with its size, and the change's other
  artifacts carry their content

#### Scenario: A change within the cap is sent whole

- **WHEN** a client reads a change whose answer fits the frame cap
- **THEN** no piece of it is marked as left out

#### Scenario: A list over the cap is refused with the limit

- **WHEN** a client lists the changes of a folder whose list would exceed the frame cap
- **THEN** the answer is an error stating the limit

### Requirement: A client watches one folder's OpenSpec and is told when it changes

A client SHALL be able to watch the OpenSpec content of one folder at a time. Watching another folder SHALL replace
the watch, a watch request naming no folder SHALL end it, and the watch SHALL end with the connection. Watching a
folder that is not in the workspace SHALL be answered as not found.

When the watched folder's OpenSpec content changes on disk, including in another working tree of its repository,
the connection SHALL receive an event naming the folder. The event SHALL carry no content; a client reads again what
it shows. Connections not watching that folder SHALL NOT receive it.

For one folder, events SHALL be sent at most once a second, and every change SHALL be followed by an event within a
second or so. Folders SHALL be throttled independently. A folder removed from the workspace SHALL produce no further
events.

The protocol document SHALL state that a desktop listing the watch operation in its authentication answer sends the
OpenSpec results in the shapes the document names, and that a desktop not listing it may send additional fields,
artifacts in another order, and no change events.

#### Scenario: Writing a task file announces the watched folder

- **WHEN** a client watches a folder and an agent then writes the `tasks.md` of a change of that folder that lives in
  a linked working tree outside the folder
- **THEN** the client receives an event naming that folder, and reading the change again returns the new content

#### Scenario: A burst of writes is announced at most once a second, and its end is announced

- **WHEN** a watched folder's OpenSpec content changes many times within a few seconds
- **THEN** the client receives at most one event for that folder per second, and an event after the last change

#### Scenario: A connection not watching the folder is not told

- **WHEN** two clients are connected, one watching a folder and the other watching another folder, and the first
  folder's OpenSpec content changes
- **THEN** only the first client receives an event

#### Scenario: Watching another folder replaces the watch

- **WHEN** a client watches one folder and then another, and the first folder's OpenSpec content changes
- **THEN** the client receives no event for the first folder

#### Scenario: A removed folder is not announced

- **WHEN** a client watches a folder, its OpenSpec content changes, and the folder is removed from the workspace
  before the event is sent
- **THEN** the client receives no event for that folder
