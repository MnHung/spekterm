## ADDED Requirements

### Requirement: A tool result holding images says how many it holds

The conversation view SHALL label a tool result that lists images with the number of images it holds, beside the
result's or the failure's label. The label SHALL come from the dictionary in every supported language, with the
language's plural forms. The view SHALL NOT show the images themselves.

**Reason**: a result of reading an image has no text, so without the count the desktop shows an empty result and
the user cannot tell that the agent looked at a picture.

#### Scenario: A result with one image says so

- **WHEN** the conversation holds a tool result that lists one image and no text
- **THEN** the result's label says it holds one image

#### Scenario: A result without images has no count

- **WHEN** the conversation holds a tool result with only text
- **THEN** the result's label carries no image count
