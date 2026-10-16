# remote-attachments Specification

## Purpose
Files a paired device uploads to attach to a reply: where the desktop stores them, under what names, which kinds and sizes it accepts, how long it keeps them, and how the agent is allowed to read them.

## Requirements

### Requirement: An uploaded file is stored only in the desktop's attachment store, under a name the desktop chooses

A paired device SHALL be able to upload a file for an agent session. The desktop SHALL store it under its own
data directory, in a directory for that session. The file name SHALL be chosen by the desktop: a new
identifier joined to the device's file name with every character other than letters, digits, `.`, `-` and
`_` replaced, leading dots removed, and clipped to 80 characters. An image or a PDF SHALL carry the extension
its content implies. Text whose name has no extension, or an image's or a PDF's extension, SHALL get `.txt`
appended, so the agent does not decode it as an image. Files SHALL be readable and writable by the user only,
and not executable. The resulting path SHALL be checked to lie within the session's directory.

Whether an attachment was sent SHALL be kept on disk, so it survives a restart.

No parameter of the upload SHALL name a directory or a path. An upload for a session that does not exist
SHALL be refused as not found. An upload for a session that is not an agent session SHALL be refused as
having no conversation.

#### Scenario: A file name with path segments is stored inside the store

- **WHEN** a device uploads a file named `../../.bashrc` for an agent session
- **THEN** the file is stored inside that session's attachment directory, under a name with no path separator and no leading dot

#### Scenario: An upload for a shell session is refused

- **WHEN** a device uploads a file for a shell session
- **THEN** the upload is refused as having no conversation, and nothing is stored

### Requirement: An upload arrives in ordered chunks and is accepted only as an image, a PDF or text, within limits

A file SHALL be uploaded in one or more chunks. Each chunk SHALL carry at most 512 KiB of content, and each
chunk after the first SHALL start exactly where the content received so far ends. Otherwise it SHALL be
refused, with the amount received so far. The declared size SHALL be fixed by the first chunk.

When the content received reaches the declared size, the desktop SHALL decide the kind by the content, not
by the name:

- a PNG, JPEG, GIF, WebP or PDF signature;
- otherwise UTF-8 text with no NUL character.

Anything else SHALL be refused as an unsupported type, and the content SHALL be removed.

The limits SHALL be:

- 10 MiB per file;
- 200 MiB stored per session;
- 10 attachments not yet sent per session, uploads in progress included.

An upload over a size limit SHALL be refused, naming the limit. An upload beyond the not-yet-sent limit SHALL
be refused as too many.

#### Scenario: A photo in two chunks becomes an attachment

- **WHEN** a device uploads a JPEG of 700 KiB in two chunks
- **THEN** the second chunk's answer says the upload is complete, and the stored file holds exactly the uploaded bytes

#### Scenario: A chunk out of order is refused

- **WHEN** a device sends a second chunk that starts before the end of the first
- **THEN** it is refused with the amount received so far, and the stored content is unchanged

#### Scenario: A binary that is not an accepted kind is refused

- **WHEN** a device uploads an executable named `photo.png`
- **THEN** the upload is refused as an unsupported type, and nothing remains stored

#### Scenario: Text named like an image is stored as text

- **WHEN** a device uploads UTF-8 text named `photo.png`
- **THEN** the stored file's name ends in `.txt`

#### Scenario: A file over the size limit is refused

- **WHEN** a device declares a file of 11 MiB
- **THEN** the upload is refused, naming the 10 MiB limit, and nothing is stored

### Requirement: A reply can carry attachments, and the agent is told where they are

A reply from a device SHALL be able to name up to ten completed attachments of the same session that have not
been sent yet. Its text MAY then be empty. Naming more than ten SHALL refuse the reply as malformed. Naming an
attachment that is not complete, not that session's, or already sent SHALL refuse the reply as not found.
Either way nothing SHALL be written. An attachment SHALL be taken by the first reply that names it, so two
replies cannot both send it.

The desktop SHALL add one sentence to the reply. It says that the user attached files from their phone and
gives each one's full path in backticks, inside the sentence, never on a line of its own. The sentence is
agent-protocol copy: English, not translated. The answer to the reply SHALL carry the exact text written
before the submit key. An attachment SHALL count as sent once its reply's text is written.

**Reason**: in a reply long enough for the agent to take it as a paste, an image path on a line of its own is
turned into an inline image. The message is then recorded in a shape the conversation projection does not
show (measured, CLI 2.1.300). A path inside a sentence is left as text, and the agent reads the file.

#### Scenario: An attachment-only reply reaches the agent with the file's path

- **WHEN** a device replies to its watched agent with no text and one uploaded image
- **THEN** the agent receives one message naming the stored image's full path inside a sentence, followed by the submit key, and the reply's answer carries that exact text

#### Scenario: An attachment cannot be sent twice

- **WHEN** a device replies naming an attachment it already sent
- **THEN** the reply is refused as not found, and nothing is written to the session

### Requirement: Agent sessions can read the attachment store without a permission prompt

While agent event reporting is enabled, every agent session the desktop starts SHALL be given permission to
read the attachment store through the injected settings, as a read rule, not as an additional working
directory. The rule SHALL merge with the user's own permission settings and SHALL NOT replace them. It SHALL be
contributed whether or not remote access is on. With event reporting disabled, it SHALL NOT be contributed:
a reply cannot be sent without the wait state, so attachments are unusable, and no settings should be passed
on its account.

**Reason**: measured (CLI 2.1.300), reading a file outside the working directories raises a permission
prompt. A read rule for the directory in the injected settings removes it. Injected permission settings kept
the user's default permission mode. An additional working directory would also let accept-edits mode write
there.

#### Scenario: The injected settings name the store

- **WHEN** the desktop starts an agent session with event reporting enabled
- **THEN** the settings it passes to the agent allow reading under the attachment store, alongside the event hooks, and do not list it as a working directory

#### Scenario: No read rule without event reporting

- **WHEN** the desktop starts an agent session with event reporting disabled
- **THEN** the settings passed to the agent, if any, contain no rule for the attachment store

### Requirement: Attachments are removed with their session, and after a time limit

A session's attachments SHALL be removed when the session is closed, whether it is running or dormant, and
SHALL be kept while it is dormant. At startup, the desktop SHALL remove:

- the attachment directories of sessions it no longer has;
- attachments older than 30 days.

An attachment not sent within 24 hours of its upload starting, complete or not, SHALL be removed at startup,
or when its session next receives an upload.

#### Scenario: Closing a session removes its attachments

- **WHEN** a session with attachments is closed on the desktop
- **THEN** its attachment directory no longer exists

#### Scenario: Closing a dormant session removes its attachments

- **WHEN** a dormant session with attachments is closed on the desktop
- **THEN** its attachment directory no longer exists

#### Scenario: Hibernating a session keeps its attachments

- **WHEN** a session with attachments is hibernated
- **THEN** its attachments are still stored
