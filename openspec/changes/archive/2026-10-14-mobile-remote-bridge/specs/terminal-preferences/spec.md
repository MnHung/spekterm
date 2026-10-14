## ADDED Requirements

### Requirement: Settings has a remote access section

The Settings interface SHALL contain a remote access section. It SHALL state one of the following:

- that remote access is off;
- that it is on, with the number of paired devices and how many of them are connected;
- that it failed to start, with the cause (see `remote-access`).

The section SHALL offer a control that opens the remote access dialog. The section SHALL NOT itself
change remote access. Turning it on and off, pairing and revoking all happen in the dialog, which states
what a paired device can do.

#### Scenario: The section states that remote access is off

- **WHEN** remote access was never turned on and the user opens Settings
- **THEN** the remote access section states that remote access is off

#### Scenario: The section counts devices

- **WHEN** remote access is on with two paired devices, one of them connected, and the user opens Settings
- **THEN** the remote access section states that it is on, with two devices and one connected

#### Scenario: The section opens the remote access dialog

- **WHEN** the user activates the remote access section's control
- **THEN** the remote access dialog opens
