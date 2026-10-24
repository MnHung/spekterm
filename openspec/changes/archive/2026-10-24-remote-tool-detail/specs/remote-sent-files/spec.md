## ADDED Requirements

### Requirement: A device reads only a file the agent sent to the user, addressed by the agent's call

A paired device SHALL be able to read a file the agent of an agent session sent to the user with its tool for
sending files. The device SHALL address the file by that tool call's identifier and the file's position in the
call's list of files. No parameter SHALL name a path or a directory.

The desktop SHALL resolve the address from the session's current transcript — the one the conversation shows —
using the path exactly as the call recorded it, untruncated. A call that is not the agent's tool for sending
files, a call in a subagent's records, a position the call does not have, and a recorded path that is not
absolute SHALL be refused as not sent. A file sent in an earlier transcript of the session (before the agent
cleared or switched its conversation) SHALL be refused as not sent.

Reading SHALL NOT require the device to watch the conversation. A session that does not exist, or whose agent has
no running process, SHALL be refused as not found; a shell session SHALL be refused as having no conversation.

#### Scenario: A file the agent sent is read

- **WHEN** the agent sent the user a file, and a device reads it by that call's identifier and the file's position
- **THEN** the device receives the file's content, its base name and its media type

#### Scenario: A file that was not sent is refused

- **WHEN** a device names a call identifier that the session's current transcript has no file-sending call for, or a position past the call's files
- **THEN** the read is refused as not sent, and no file is read

#### Scenario: A file sent before the conversation was cleared is refused

- **WHEN** the agent sent a file, the conversation was then cleared, and a device reads it by the earlier call
- **THEN** the read is refused as not sent

#### Scenario: An earlier file is found after a later one was read

- **WHEN** the agent sent two files in two calls, and a device reads the later one and then the earlier one
- **THEN** both reads return their file

#### Scenario: A call written while the device reads is found once complete

- **WHEN** a device reads a file whose call the agent has not finished writing to the transcript, and reads again after the line is complete
- **THEN** the first read is refused as not sent and the second returns the file

#### Scenario: A sent file is found in a transcript that keeps growing

- **WHEN** the agent sent a file and keeps writing to its transcript while a device reads the file in several chunks
- **THEN** every chunk is answered from the same resolved file

#### Scenario: Reading does not need a watch

- **WHEN** a device that is not watching the session's conversation reads a file the agent sent
- **THEN** the device receives the file

### Requirement: A listed file is read whatever it holds

A file the agent listed SHALL be read whatever its location or content, a credential included. The desktop SHALL
NOT keep a list of locations it refuses.

**Reason**: a device can already read any file through the session's terminal, so refusing some locations adds
no protection; and no such list can be complete.

#### Scenario: A file in spekterm's data directory is read when listed

- **WHEN** the agent sent a file inside spekterm's data directory, and a device reads it
- **THEN** the device receives the file

### Requirement: A sent file is read in chunks, within a size limit, and a change between chunks is reported

A sent file SHALL be read in chunks of at most 512 KiB of content, or of at most the smaller length the device
asks for, starting at the offset the device names, each
answer stating the file's size, whether the read reached the end, and a version that changes when the file is
replaced or its size or modification time changes. A chunk read naming a version that is no longer the file's SHALL be refused as
changed. An offset past the file's size SHALL be refused as a bad parameter.

A file larger than 32 MiB SHALL be refused as too large, stating the limit. A path that no longer exists, or that
is not a regular file, SHALL be refused as gone, and SHALL be refused without waiting on it (a named pipe must not
hold the desktop). A chunk SHALL NOT carry more than the size the answer states. The media type SHALL be derived from the file's extension, with a
generic binary type for an extension the desktop does not know.

#### Scenario: A large file arrives in several chunks

- **WHEN** a device reads a sent file of 2 MiB from offset 0 and continues from each answer's end with the version it was given
- **THEN** it receives the whole file in chunks of at most 512 KiB, and the last answer says the end was reached

#### Scenario: A smaller chunk is asked for

- **WHEN** a device reads a sent file asking for 64 KiB per chunk
- **THEN** no chunk carries more than 64 KiB of content

#### Scenario: A file changed during the download is reported

- **WHEN** the file is replaced, or changes size or modification time, after the first chunk, and the device reads the next chunk with the first version
- **THEN** the read is refused as changed

#### Scenario: A deleted file is reported as gone

- **WHEN** the agent sent a file that was later deleted, and a device reads it
- **THEN** the read is refused as gone

#### Scenario: A named pipe is refused at once

- **WHEN** the agent sent a path that is a named pipe with no writer, and a device reads it
- **THEN** the read is refused as gone without waiting

#### Scenario: An oversized file is refused with the limit

- **WHEN** a device reads a sent file larger than 32 MiB
- **THEN** the read is refused as too large, stating the limit, and no content is sent
