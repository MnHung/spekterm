## Why

Settings grew one field at a time: language, three font fields, GPU, agent status reporting, automatic
hibernation, a remote access line and the build identity. They sit in one narrow (384px), unlabelled column,
so the user scans all of it to find one knob. They also follow two save models: the language applies at once,
everything else waits for Save, and "Reset to default" applies at once without asking. Settings' remote line
closes Settings and opens a separate remote access dialog in its place, which adds a third model of its own (a switch that applies at once, a port with a
"Use port" button, an address with a "Save address" button). The Slack connection settings are knobs too, but
they live in a tab of the inbox, in one form with three models (per-row Save, save on change, save on blur).
Save also closes the dialog before the writes finish, so a failed write is never shown.

The next knob makes this worse, and every new integration would add another place to look. This change gives
the app one place for its settings, one way of saving, and a layout that has room to grow.

## What Changes

- **Settings becomes a sectioned dialog.** A wider dialog has a list of sections on the left and the chosen
  section on the right. Its size is fixed, so switching sections does not move the dialog. It has a visible
  title and a close control, and Esc closes it. The sections are:
  - **General**: language.
  - **Terminal**: font family, size and line height, with the preview directly below them; GPU acceleration.
  - **Agents & sessions**: agent status reporting; automatic hibernation; whether agent sessions show the
    terminal or the conversation view (the existing global preference, until now reachable only from the
    tab bar).
  - **Integrations**: Slack (tokens, look-back window, API endpoint, connection status).
  - **Remote access**: the content of today's remote access dialog.
  - **About**: the build identity.
- **One save model: a change applies when it is made.**
  - A choice (select, checkbox) applies at once.
  - A typed value (font size, line height, look-back window, port, address, endpoint) applies on Enter or
    when focus leaves the field; an invalid value is rejected in place and the stored value comes back.
  - The preview follows what is typed before it is applied.
  - Save and Cancel go away.
  - **Exceptions, each explicit:**
    - Slack tokens and the remote port apply through their own button or Enter, never on leaving the field:
      a half-pasted secret must never be stored, and a port change drops connected devices.
    - Pairing, revoking a device and resetting remote access stay explicit actions.
    - Revoking a device now asks first, as resetting already does.
- **A failed write is shown** next to the field, and the field shows the stored value. Today the dialog closes
  before the write returns. The stores also stop keeping a value they failed to write: today it lingers in memory
  and reaches the disk with the next successful write.
- **An invalid Slack endpoint is refused** and the stored one stays. Today it silently resets to the default.
- **Restore defaults per section, after a confirmation.** This replaces the global "Reset to default", which
  reset four unrelated things, skipped the language, and asked nothing.
- **The remote access dialog is removed.** Its content becomes the Remote access section. The activity bar's
  connected-device indicator opens Settings on that section. **BREAKING** for the probes that drive the dialog.
- **The inbox loses its Slack tab.** It keeps Inbox and Routing rules: the rules decide where an item opens, so
  they stay with the items. While Slack is set up and not working, the inbox shows a one-line status that opens
  Settings › Integrations. An empty inbox must still say whether nobody mentioned the user or the connection is
  broken.
- **Opening the inbox or the metrics closes Settings**, including from a notification, so two modal layers never
  compete.
- **One dialog frame.** A shared component provides the title, the close control, Esc, the initial focus and
  `aria-modal`. Settings is the first dialog built on it; other dialogs move to it later.

**For review:**

- **Moving Slack into Settings reverses two recorded decisions.** `slack-intake-source` and `intake-routing`
  keep their editors out of the preferences dialog because that dialog's content is enumerated by
  `terminal-preferences`. This change moves Slack in and keeps the routing rules out. Storage does not change:
  the Slack settings keep their own file and the secrets their own store. The reasons those requirements give
  for separate storage are untouched.
- **Adding the conversation/terminal view choice to Settings** is new scope. It is the same preference as the
  tab bar toggle, and Settings shows it so that a global choice is not found only on a per-session-looking
  control.
- **Instant apply means no Cancel.** Undoing a change means changing it back, or restoring the section's
  defaults.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `terminal-preferences`:
  - the preferences interface is sectioned, applies each change when made, shows write failures and resets
    per section after confirming;
  - the remote access section contains the remote access controls instead of opening a dialog;
  - Settings shows the view preference.
- `remote-access`:
  - its controls live in the Settings section instead of a dialog;
  - the connected-device indicator opens that section;
  - revoking a device asks first.
- `slack-intake-source`:
  - the connection settings are edited in Settings › Integrations, not in the inbox;
  - the requirement that kept them out of the preferences dialog is rewritten, and separate storage stays;
  - an invalid endpoint is refused;
  - the inbox keeps a status line while Slack is broken.
- `intake-routing`: the rules editor stays in the inbox, and the reason for it is restated now that the
  preferences dialog is no longer limited to terminal preferences.
- `agent-conversation-view`: the view preference is also offered in Settings.

`keyboard-navigation` needs no change: its list of dialogs that suppress shortcuts already names Settings and never
named the remote access dialog.

## Impact

- **Renderer:**
  - `shell/settings/TerminalFontDialog.tsx` becomes a sectioned `SettingsDialog`, with one module per section;
  - `shell/remote/RemoteAccessDialog.tsx` becomes the Remote access section;
  - `shell/intake/SlackSettings.tsx` moves under Settings, and `IntakeOverlay.tsx` drops its Slack tab;
  - `ActivityBar.tsx` gains the indicator's route into Settings;
  - `PreferencesProvider.tsx` serializes writes, which today depend on the dialog chaining them;
  - a new shared dialog component.
- **Main process:**
  - `preferences-store.ts` and `slack-settings-store.ts` assign their state only after the file is written;
  - `slack-settings-store.ts` refuses an invalid endpoint;
  - `ipc/slack.ts` returns that refusal as a result object.

  The IPC surface is otherwise unchanged.
- **Dictionaries:**
  - new keys for the section names, confirmations and write failures;
  - `settings.save` and the global reset go away;
  - both languages.
- **Probes:**
  - `terminal` and `workspace`, which press Save;
  - `package` and `package-mac`, which read the build identity;
  - `remote`, which drives the remote dialog;
  - `slack` and `intake`, which use the inbox's Slack tab;
  - the scenario coverage table.
- **Website:** in English and Traditional Chinese:
  - the settings reference;
  - the inbox and Slack page;
  - the remote access page;
  - the data and network page (where Slack credentials are saved);
  - the terminals and sessions page (the path to Settings);
  - the conversation view page (the view is also in Settings).
- **`docs/remote-protocol.md`** names the desktop's remote access dialog. The Android client follows that document.
