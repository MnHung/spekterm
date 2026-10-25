## Purpose

Images that a tool result in an agent session's conversation holds, which a paired device reads: how they are
addressed (by the result and a position, never by a path), where the bytes come from, the chunking, the limit and
the errors.

## ADDED Requirements

### Requirement: A device reads an image a tool result holds, addressed by the result and its position

A paired device SHALL be able to read an image that a tool result in an agent session's conversation holds. The
device SHALL address it by the tool result's identifier and the image's position among the images that result's
conversation entry lists. No parameter SHALL name a path or a directory.

The position SHALL designate the same image the entry listed at that position: the images a device can read and
the images an entry lists SHALL be the same images in the same order.

The desktop SHALL resolve the address from the session's current transcript — the one the conversation shows. A
result the current transcript does not hold, a result that holds no listed image, a position past its images, a
result in a subagent's records, a record of another kind that holds the same identifier, and a result recorded
before the agent cleared or switched its conversation SHALL be refused as having no such image.

Reading SHALL NOT require the device to watch the conversation. A session that does not exist, or whose agent has
no running process, SHALL be refused as not found; a shell session SHALL be refused as having no conversation.

#### Scenario: An image the agent read is read by a device

- **WHEN** the agent read an image file, and a device reads position 0 of that result
- **THEN** the device receives the image's bytes and its media type

#### Scenario: The second image of a result with text and two images is the second one listed

- **WHEN** a tool result holds text, then two images, and a device reads position 1
- **THEN** the device receives the second image, with the media type the entry listed at position 1

#### Scenario: A result without images is refused

- **WHEN** a device names a tool result that holds only text, or a position past a result's images
- **THEN** the read is refused as having no such image

#### Scenario: Another record holding the same identifier is not read

- **WHEN** the transcript holds, besides the result, another kind of record with the same tool result identifier and a different image
- **THEN** a device reading that identifier receives the result's image, not the other record's

#### Scenario: An image recorded before the conversation was cleared is refused

- **WHEN** a tool result held an image, the conversation was then cleared, and a device reads it by the earlier identifier
- **THEN** the read is refused as having no such image

#### Scenario: A result written while the device reads is found once complete

- **WHEN** a device reads an image whose result the agent has not finished writing to the transcript, and reads again after the line is complete
- **THEN** the first read is refused as having no such image and the second returns the image

#### Scenario: An earlier image is found after a later one was read

- **WHEN** two results each hold an image, and a device reads the later one and then the earlier one
- **THEN** both reads return their image

#### Scenario: Reading an image does not need a watch

- **WHEN** a device that is not watching the session's conversation reads an image a result holds
- **THEN** the device receives the image

#### Scenario: A shell session has no images to read

- **WHEN** a device reads an image of a shell session
- **THEN** the read is refused as having no conversation

### Requirement: The bytes are the image the agent was given, taken from the transcript

The bytes a device receives SHALL be the image as the tool result recorded it in the transcript — what the agent
was given, possibly scaled by the agent's CLI — and SHALL NOT be read from a file on disk.

**Reason**: the image is then the one the agent saw; it exists when the file was deleted and for an image that was
never a file (a screenshot); and no read can be steered to an arbitrary file.

#### Scenario: An image whose file was deleted is still read

- **WHEN** the agent read an image file that was later deleted, and a device reads that result's image
- **THEN** the device receives the image as the result recorded it

#### Scenario: The bytes are the result's, not another copy the record holds

- **WHEN** the record of a result also holds, outside the result, a different copy of the image
- **THEN** a device reading the result's image receives the bytes the result holds

#### Scenario: A screenshot that was never a file is read

- **WHEN** a tool returned a screenshot as an image in its result, and a device reads it
- **THEN** the device receives the screenshot

### Requirement: An image is read in chunks, within a size limit, and a change between chunks is reported

An image SHALL be read in chunks of at most 512 KiB of content, or of at most the smaller length the device asks
for, starting at the offset the device names. Each answer SHALL state the image's size, whether the read reached
the end, and a version that differs for different image content. A chunk read naming a version that is no longer
the image's SHALL be refused as changed. An offset past the image's size SHALL be refused as a bad parameter. A
chunk SHALL NOT carry more than the size the answer states.

An image larger than 8 MiB SHALL be refused as too large, stating the limit, and no content SHALL be sent.
A result recorded on a transcript line longer than 32 MiB SHALL be refused as too large as well, without the line
being read.

#### Scenario: A large image arrives in several chunks

- **WHEN** a device reads an image of 1.5 MiB from offset 0 asking for 512 KiB per chunk, continuing from each answer's end with the version it was given
- **THEN** it receives the whole image in chunks of at most 512 KiB, the bytes equal to the recorded image, and the last answer says the end was reached

#### Scenario: A smaller image chunk is asked for

- **WHEN** a device reads an image asking for 64 KiB per chunk
- **THEN** no chunk carries more than 64 KiB of content

#### Scenario: A different image under the same address is reported

- **WHEN** a device read a first chunk, and the current transcript then holds a different image under that result's identifier and position, and the device reads the next chunk with the first version
- **THEN** the read is refused as changed

#### Scenario: An offset past the image is refused

- **WHEN** a device reads an image from an offset past its size
- **THEN** the read is refused as a bad parameter

#### Scenario: An oversized image is refused with the limit

- **WHEN** a device reads an image larger than 8 MiB
- **THEN** the read is refused as too large, stating the limit, and no content is sent
