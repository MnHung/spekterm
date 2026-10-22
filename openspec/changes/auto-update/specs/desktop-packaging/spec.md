## ADDED Requirements

### Requirement: A release publishes the update metadata with its Linux artifact

The project SHALL provide a script that publishes a version's GitHub release. It SHALL refuse unless the
current commit is the release commit of the declared version and is on the remote's `master`; it SHALL NOT
require a clean working tree. It SHALL upload the Linux AppImage only together with the update metadata file
built with it, and SHALL refuse when one of the two is missing, when the metadata's version is not the declared
version, or when its checksum is not the AppImage's. A new release (tag `v<version>`, hand-written notes from a
file) SHALL become visible as the latest release only once all of its assets are uploaded; an existing release
SHALL have assets added or replaced, so that the macOS artifact can be added later. Packaging SHALL
NOT publish anything by itself.

#### Scenario: The AppImage is not published without its metadata

- **WHEN** the script runs with the AppImage of the declared version in the output directory but no update
  metadata file
- **THEN** it refuses, names the missing file, and uploads nothing

#### Scenario: Mismatched metadata is refused

- **WHEN** the metadata file's version or checksum does not match the declared version's AppImage
- **THEN** it refuses and uploads nothing

#### Scenario: An unpushed release commit is refused

- **WHEN** the release commit is not on the remote's `master`
- **THEN** it refuses and creates no release

#### Scenario: A new release is invisible while uploading

- **WHEN** the script creates a new release
- **THEN** it is a draft until the AppImage and the metadata are both uploaded, and is published after that

#### Scenario: An existing release gains the macOS artifact

- **WHEN** the release of the declared version exists and the script runs where only the dmg is present
- **THEN** it uploads the dmg to that release and changes nothing else

#### Scenario: Packaging publishes nothing

- **WHEN** `npm run dist:linux` or `npm run dist:mac` runs
- **THEN** no release is created or changed
