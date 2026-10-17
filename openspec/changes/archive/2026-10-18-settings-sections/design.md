## Context

See proposal.md for why. The current state this design changes:

- **Settings** (`shell/settings/TerminalFontDialog.tsx`) is one `max-w-sm` card, scrolling inside the window. It
  holds local copies of the font, GPU, agent status and hibernation values and writes them on Save, chained one
  after another, then closes without waiting. The language select writes at once. The global "Reset to default"
  writes four groups at once.
- **Each `PreferencesProvider` update is a separate IPC** that returns the whole applied preferences and replaces
  local state with them. The settings handlers are synchronous except `setLanguage`, so their replies arrive in
  the order sent (inferred from `ipcMain.handle`, not measured).
- **The font is one write of three values.** `setTerminalFont(family, size, lineHeight)` rebuilds the whole font
  group from its arguments (`preferences-store.ts`, "`null` = clear to default"). Changing one font field therefore
  means sending the other two as well.
- **The stores change memory before the file.** `PreferencesStore`'s setters and `SlackSettingsStore`'s
  `setLookbackDays` / `setApiBaseUrl` assign `this.preferences = next` (or `#settings`) and then save. When the
  save throws, the IPC rejects, but memory keeps the new value: `settings.get()` returns it, and the next
  successful write of any field puts it on disk.
- **The Slack endpoint is sanitized silently.** `setApiBaseUrl` turns an invalid or non-https value into "unset",
  that is, back to the default, and reports nothing (`sanitizeApiBaseUrl`). The endpoint field is an empty draft
  with the current value as its placeholder.
- **Remote access** (`shell/remote/RemoteAccessDialog.tsx`) is a dialog with its own close, opened from Settings'
  remote line or from the activity bar's connected-device indicator. Its body (`DialogBody`) needs only the remote
  state and the pairing flag. Pairing ends when the dialog unmounts.
- **Slack** (`shell/intake/SlackSettings.tsx`) is a prop-less component in the inbox's third tab. It talks only to
  `window.workspace.slack`. Its routing hint is static text.
- **Agent view** is one global preference (`agent-conversation-view`), toggled from the tab bar through
  `updateAgentView`.
- **Probes select by the dialog's `aria-label` and by field labels from the dictionary.** `probe:terminal`,
  `probe:files`, `probe:workspace`, `probe:package`, `probe:package-mac`, `probe:keyboard` and `probe:slack` open
  Settings or the Slack tab. `probe:remote` drives the remote dialog. Several press Save.

## Goals / Non-Goals

**Goals:**

- One frame, one save model, sections that can grow, and failures that are shown.
- No change to what is stored or where it is stored.
- Main-process changes are limited to what instant apply makes visible:
  - a failed write leaves memory unchanged;
  - an invalid Slack endpoint is refused instead of silently reset (D7).

**Non-Goals:**

- Moving the other dialogs (file name and delete dialogs, session name, handoff brief, close completed, report
  authorization) onto the shared frame. This change builds the frame and uses it for Settings only. The others move
  in a later change, which is why the frame is a component and not part of Settings.
- A keyboard shortcut for Settings, a settings search, and per-workspace settings.
- Changing the routing rules editor, which stays in the inbox.
- The remote access store's write path. `remote-store.ts` `#replace` assigns, logs a failed write, notifies, and
  reports success, and reset goes through it. Making it fail visibly is its own change. Until then a failed
  remote write is not shown: the spec states this as a known gap, tracked as issue #88.

## Decisions

### D1. A fixed-size modal with a vertical section list

The dialog keeps `role="dialog"` and the `settings.title` label, so the dialog check in `keyboard-navigation` and
the probes' entry point still work.

Layout:

- Size: `min(760px, 100vw - 2rem)` wide and `min(600px, 100vh - 2rem)` tall, at every section.
- Left: the section list, a `role="tablist"` with `aria-orientation="vertical"`. It has one tab per section,
  roving focus, and ↑/↓/Home/End to move.
- Right: a `role="tabpanel"` that scrolls on its own. Its heading is the section name.
- The last section shown is remembered for the app's run. It is not stored.

Alternatives:

- **One scrolling page with headings.** Rejected. Remote access alone (QR code, device list) and Slack would make
  the page several screens tall, and a list of sections tells the user what exists without scrolling.
- **A full-window overlay**, like the inbox. Rejected. Settings is visited briefly and on top of the work. A modal
  keeps the work visible around it and needs no navigation back.

### D2. When a value applies

The rule depends on the control:

- **Select, checkbox, radio:** applies on change.
- **Typed fields** (font size, line height, look-back, port, address, endpoint):
  - the value applies on Enter or on blur, and only if it differs from the stored value;
  - the preview reads the typed value before it applies;
  - after the write, the field shows what the main process applied, which can be clamped;
  - **Esc in a field with an unapplied edit puts the stored value back and stops there.** A second Esc closes
    Settings. Without this, the only way to drop an edit would be to delete it by hand, now that Cancel is gone.
  - Likewise, Esc while an inline confirmation is open (D5, D6) cancels that confirmation first, as the report
    authorization does (`ReportTab.tsx`).
  - Number fields read `validity.badInput` before the value. A number input reports `""` for text it cannot
    parse (`1e`, `--`), and taking that as "empty = default" would silently clear the stored value. Bad input is
    rejected, and the stored value comes back.
  - **Choosing a font family sends the stored size and line height, not a typed value that has not applied.**
    Typed values apply only on Enter or blur, and a selection elsewhere is neither.
  - Clicking the close control blurs the field first, so the edit applies. That matches what the field shows when
    the click happens.
- **Slack tokens:** keep their Save and Clear buttons and also save on Enter, but never on blur. A token is often
  pasted in pieces, and applying on blur could store half a secret. The hint under the field says so. The remote
  port follows the same rule (D6). Together these are the only two exceptions, stated the same way in the spec:
  "applies through its own control or Enter, never when focus leaves the field".

Alternative: keep Save and Cancel and make the language wait too. Rejected by the user (proposal). It also leaves
the remote and Slack forms with their own models.

### D3. `PreferencesProvider` builds each write when its turn comes

Every update goes through one queue inside the provider. **A queue entry is a function of the last applied
preferences, not a call with its arguments already bound.** When an entry's turn comes, it reads the preferences
the previous write returned and builds its call from them. For example, a font size change is
`prev => setTerminalFont(prev.fontFamily, 18, prev.lineHeight)`.

This is what makes the font group safe. A size change followed quickly by a family change would otherwise bind
the family write to the old size and undo the size. Ordering alone does not prevent this; reading the
arguments late does. Each write's result becomes local state. A rejection reaches only its own caller and
leaves the chain and the state as they were.

The queue sits in the provider, not in the Settings dialog, because instant apply removes the single call site
that used to chain the writes. Writes made outside the Settings dialog, such as the tab bar's view toggle, go through the same queue.

**Rejected:** binding arguments at enqueue time and relying on the queue's order. It keeps the replies in order
but still sends a stale font triple. Before this design the Save chain hid the problem by sending all three
fields from one form.

### D4. Failures are shown at the field, and leave nothing behind

A field whose write rejects shows the stored value again, with a one-line message under it (`role="alert"`). The
message comes **from the dictionary only**. The error's own text goes to the console: it is English, and it carries
the user-data path. It is the third kind of user-visible text in CLAUDE.md's i18n section. Nothing closes, so the
user sees it.

For "the stored value" to be true, the stores assign only after the file is written. These setters build `next`,
save it, and only then replace their state:

- `PreferencesStore`'s setters;
- `SlackSettingsStore`'s setters;
- `SecretStore`'s `set` and `delete`, which the token Save goes through and which have the same assign-first order. A throw leaves the
previous state, so `settings.get()` and every later write still see it.

The probe forces a real failure with no test branch in the product: it creates a directory at
`<userData>/preferences.json.tmp`, so the atomic write's `writeFileSync` throws `EISDIR`. The probe then removes
the directory again.

The same applies to Slack's look-back and endpoint, whose failures are dropped today.

### D5. Restore defaults per section, after a confirmation

Restore applies to two sections:

- **Terminal:** restores font family, size, line height and GPU.
- **Agents & sessions:** restores agent status reporting, automatic hibernation and the view.

The button asks first, in place: "Restore defaults?", with Restore and Cancel. This is the pattern the remote reset
already uses. Restoring writes through the queue (D3).

Esc while the confirmation is open cancels it (D2). Restoring Agents & sessions sets the view to its default, so
`updateAgentView` accepts `null`.

Sections without it:

- **General:** restoring the language to English is a trap for a reader of another language, who then has to find
  the select in a language they cannot read.
- **Integrations:** the endpoint has its own Reset, and tokens have Clear.
- **Remote access:** "Reset remote access" already exists and means something stronger (a new certificate, every
  device revoked).

### D6. Remote access becomes a section

`DialogBody` and its parts move under `settings/sections/` unchanged in what they show. Changes:

- Pairing ends when the section unmounts, whether by switching sections or closing Settings, the same rule the
  dialog follows today.
- **Revoke asks first**, inline, like Reset. Revoking ends a device's access and the device must pair again.
- The port keeps its "Use port" button and also applies on Enter, but not on blur. A port change restarts the
  listener and drops connected devices, so it stays a deliberate action rather than an effect of leaving the
  field. This is the second exception to D2, stated beside the field.
  - After blur, the field keeps the typed port and says it has not been applied.
  - Esc restores the stored port.
- The additional address follows D2 and loses its "Save address" button: it only changes the pairing link.
- The activity bar's connected-device indicator opens Settings on Remote access (`initialSection`).
- **The summary line moves in with the controls.** Today's Settings `RemoteAccessSection` holds the off / on with
  devices / failed line and the `remote.section.*` keys, which the dialog body never had. That line becomes the
  first line of the section, under its existing group label, so the probes' carrier
  (`[role=group][aria-label=remote.section.label]`) keeps working.
- **A listen failure marks the section in the list.** Today the failure is visible as soon as Settings opens. Once it
  sits in a section, a failure at startup would otherwise go unseen until the user happens to open Remote access.

### D7. Slack becomes the Integrations section

`SlackSettings` moves under `settings/sections/`. It keeps the same IPC and the same separate storage
(`slack-intake-source`, `secret-scope`). Changes:

- **Look-back:** applies on Enter or blur (D2). Today it applies on every change, so typing "14" writes "1" first.
- **Endpoint:** keeps applying on blur, applies on Enter too, and shows failures (D4).
- **Routing hint:** shown only while no fallback folder is set, with a button that closes Settings and opens the
  inbox on Routing rules. `ActivityBar` already owns both surfaces, so it takes the route. `IntakeOverlay` gains an
  initial tab.
- **The endpoint field is a draft.** An empty draft does nothing, so clicking into the field and out again does not
  reset a custom endpoint. Its existing Reset button is the way back to the default.
- **An invalid endpoint is refused.** `setApiBaseUrl` with a non-null value that fails `sanitizeApiBaseUrl`:
  - throws a dedicated `InvalidEndpointError`, so the handler can tell it apart from a failed write (which
    becomes the generic failure);
  - leaves the stored endpoint unchanged;
  - reaches the renderer as `{ ok: false, code: 'INVALID_ENDPOINT' }`, since IPC drops an error's `code`.

  Today such a value resets the endpoint to the default and says nothing. Loading a stored file keeps the
  silent-to-default rule, because that is corrupted data, not an edit. `secret-scope`'s "non-https endpoint is
  not accepted" holds either way.
- **The inbox's Slack tab is removed.** The inbox has no other text that names that tab: only `slack.*` keys did,
  and they move with the section.
- **The inbox keeps one line about Slack when Slack is broken.** The user still looks at the inbox to learn whether
  an empty list means no mentions or a broken connection (`slack-intake-source`).
  - While Slack is set up and failing, rate-limited, or backing off, the inbox shows the same status line the
    section shows, with a control that opens Settings on Integrations.
  - While Slack works, or was never set up, the inbox says nothing about it.

### D8. A shared `Dialog` frame

**Opening the inbox or the conversation metrics closes Settings first,** whichever way they are opened (activity
bar, notification click, the Integrations hint). **The other direction too:** the inbox's Slack line closes the
inbox before it opens Settings, because the inbox (`z-50`) would otherwise cover Settings (`z-40`) and keep the
focus. A notification can arrive while Settings is open, for example
right after a token is saved and the catch-up finds mentions. Two modal layers would then fight over focus and
over Esc.

The frame:

`shell/ui/Dialog.tsx` provides:

- the backdrop;
- the card at a requested size;
- `role="dialog"` and `aria-modal="true"`, with the title as its label;
- a header with the title and a close control (`common.close`);
- Esc on the card, stopped there (`stopPropagation`), so that no window listener underneath also acts on it. The
  D2 rule still lets a field consume it first.
- focus moved in on open and returned to the opener on close.
- Tab kept inside by a keydown handler on the card, not by pulling focus back on `focusin`, so it can never take
  focus from a layer above.

The backdrop colour becomes a token (`--color-scrim`) instead of `bg-black/50`.

Settings is its only user in this change (see Non-Goals).

### D9. The agent view in Settings

Agents & sessions shows a two-option radio group (Terminal / Conversation) bound to `agentView` /
`updateAgentView`. It is the same preference the tab bar toggles, and either control updates the other.

### D10. Probes share one Settings helper

`scripts/lib/settings.mjs` provides three helpers:

- `openSettings(client, section)`;
- `setField(client, label, value)`, which types, then presses Enter;
- `awaitApplied(client, read)`, which polls through `pollFor`.

The probes change as follows:

- `probe:terminal` and `probe:workspace` pressed Save and now call these helpers.
- `probe:package` and `probe:package-mac` read the build identity and now show About first.
- `probe:remote` opens Settings on Remote access instead of the dialog.
- `probe:slack` opens Integrations instead of the inbox tab.

**Many scenarios keep their names**, and the coverage table (`scripts/scenario-coverage.test.mjs`) is keyed by name,
with a duplicate-row guard. So:

- a new scenario name gets a new row;
- a kept name gets its existing row's carrier and mutation updated;
- a scenario this change retires but an archived change still holds (for example "The section opens the remote
  access dialog") gets `carrier: null` with the note "superseded by settings-sections".

`scripts/slack-control-groups.mjs` names `intake/SlackSettings.tsx` by path, and `control-groups-source.test.mjs`
reads it, so the move updates those entries too.

**"The user opens Settings and sees X"** in older scenarios (build identity, the dmg's copy, the agent status
switch, the hibernation default) is read as "Settings shows the section that holds X". The `terminal-preferences`
delta says so once, rather than rewording every scenario.

## Risks / Trade-offs

- [Choosing a font family now restyles every terminal at once.] → This is the live preview the user lacked, and
  restoring defaults is one confirmed click away. The terminals already re-fit on Save today, so no new code path.
- [Instant apply has no Cancel.] → Esc reverts an unapplied field (D2), and each section can restore its defaults
  (D5). The proposal flags it for review.
- [A queue holds a slow write behind a hung one.] → Every update is one IPC to a synchronous file write in the main
  process. A hang there already blocks today's Save chain. This is not a new failure.
- [Probes break in many places at once.] → D10 puts the Settings interactions behind one helper, so each probe
  changes at its call sites only. The control-group discipline applies: the "applies on blur" assertion is checked
  against a mutation that applies only on Enter.
- [Electron's reply order is inferred, not measured.] → D3 does not depend on it: arguments are read when the write
  runs, so the outcome is the same in either order.
- [Two recorded decisions are reversed (Slack placement).] → Storage stays separate, and the requirements are
  rewritten with their reasons, not deleted (specs).

## Migration Plan

Nothing on disk changes: the preferences file, the Slack settings and secrets, and the remote state keep their
format. Rolling back is reverting the renderer and the two stores' assign-after-save order.
