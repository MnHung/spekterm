## ADDED Requirements

### Requirement: A tool result names the images it holds, without their bytes

A tool result event SHALL carry, when the result holds at least one image, the list of those images in the order
the result holds them, each with its media type and its size in bytes. Only images whose bytes are recorded in the
result as unwrapped standard base64 and whose media type is PNG, JPEG, GIF or WebP SHALL be listed, and the listed
size SHALL equal the decoded image's size; any other content block SHALL NOT be listed.
A result holding no such image SHALL carry no list. The event SHALL NOT carry an image's bytes.

The result's text SHALL stay the text the result holds, empty when it holds only images; no text SHALL be
written in place of an image.

**Reason**: a result of reading an image holds no text, so without the list the result reaches the presentation
layer as an empty one and the image is lost; the bytes stay out because a conversation can hold dozens of
screenshots and the list is sent to every watcher.

#### Scenario: An image the agent read is listed

- **WHEN** the transcript holds a tool result whose content is one PNG image
- **THEN** the result event lists one image with media type `image/png` and the image's size in bytes, and its text is empty

#### Scenario: A screenshot with text lists the image and keeps the text

- **WHEN** the transcript holds a tool result whose content is two text blocks and one JPEG image
- **THEN** the result event's text is the two texts, and it lists one image with media type `image/jpeg`

#### Scenario: A result without images lists none

- **WHEN** the transcript holds a tool result with only text
- **THEN** the result event carries no list of images

#### Scenario: Other blocks are not listed

- **WHEN** a tool result holds an image of another media type, an image without recorded bytes, an image whose bytes are line-wrapped, or a document block, besides one PNG image
- **THEN** the result event lists only the PNG image

#### Scenario: No image bytes reach the presentation layer

- **WHEN** the transcript holds a tool result with an image
- **THEN** no event carries any part of the image's recorded bytes
