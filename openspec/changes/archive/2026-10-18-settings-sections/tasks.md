## 1. Main process: failed writes leave nothing, invalid endpoints are refused (design D4, D7)

- [x] 1.1 `src/main/preferences-store.ts`: every setter saves `next` first and assigns it only after the save
      returns. Verify in `preferences-store.test.ts`:
  - with the write made to throw (a directory at `<file>.tmp`), the setter throws;
  - `get()` returns the previous value;
  - a following successful write of another field does not carry the failed value to disk;
  - control: assign-before-save turns the last assertion red.
- [x] 1.2 `src/main/slack-settings-store.ts`:
  - `setLookbackDays` and `setApiBaseUrl` follow the same assign-after-save order;
  - `setApiBaseUrl` throws an `InvalidEndpointError` for a non-null value that `sanitizeApiBaseUrl` rejects, and
    leaves the stored endpoint unchanged.

  Verify in `slack-settings-store.test.ts`:
  - an `http:` value is refused and the custom endpoint stays. This replaces the existing test that expects an
    invalid value to clear to the default (~L76-84);
  - a failed save leaves `get()` unchanged;
  - a stored invalid value still loads as the default.
- [x] 1.3 The mapping from a thrown error to the IPC result goes in a pure function beside `slack-state.ts`:
  `InvalidEndpointError` → `{ ok: false, code: 'INVALID_ENDPOINT' }`, and anything else → `{ ok: false, code:
  'WRITE_FAILED' }`. `ipc/slack.ts` uses it, with the preload type updated. Verify with a unit test of the
  function (`ipc/slack.ts` imports electron, so `node:test` cannot load it) and with `probe:slack` (7.4).
- [x] 1.4 `src/main/secret-store.ts`: `set` and `delete` save first and assign after. Verify in
      `secret-store.test.ts`: with the write made to throw, `has()` and `get()` still give the previous state.

## 2. Renderer write queue and field rules (design D2, D3)

- [x] 2.1 `src/renderer/src/shell/preferences-queue.ts`: a serial queue whose entries are functions of the last
      applied preferences. A rejection reaches only its caller and leaves the state and the chain intact. Verify
      with `preferences-queue.test.ts`:
  - a size write and a family write enqueued back to back both survive;
  - a rejected entry does not change the state seen by the next one;
  - control: a queue of pre-bound calls turns the first case red (the family write restores the old size).
- [x] 2.2 `PreferencesProvider.tsx`:
  - every update goes through the queue and rejects on failure;
  - `updateTerminalFont` takes a partial change and fills the rest from the applied preferences;
  - `updateAgentView` accepts `null`;
  - `MainStage.tsx`'s view toggle handles the rejection.

  Verify that typecheck passes and the 2.1 tests are green.
- [x] 2.3 `src/renderer/src/shell/settings/commit-field.ts`: pure functions for typed fields. They parse with
      `badInput` taken into account, decide whether the value differs from the stored one, and give the value to
      show after Esc. Verify with `commit-field.test.ts`:
  - an unchanged value is not committed;
  - empty means default;
  - `badInput` and unparseable text are rejected and the stored value comes back;
  - "14" typed in two keystrokes commits once, as 14;
  - an empty endpoint draft commits nothing.

## 3. Shared dialog frame (design D8)

- [x] 3.1 `src/renderer/src/shell/ui/Dialog.tsx`:
  - the backdrop through a new `--color-scrim` token in `index.css`;
  - `role="dialog"` and `aria-modal`;
  - a title and a close control (`common.close`);
  - Esc stopped at the card, and consumable first by a field or a confirmation;
  - focus in on open and back to the opener on close;
  - Tab kept inside by a keydown handler on the card.

  Verify with typecheck, lint and `tailwind-class-source.test.mjs`. Behaviour is verified by 7.1 and 7.2.
- [x] 3.2 `ActivityBar.tsx`: opening the inbox or the metrics closes Settings, by any route (the entries, the
      `onOpenInbox` notification path, and the Integrations hint), and the inbox's Slack line closes the inbox
      before opening Settings. Verify with `probe:intake` (7.5) and `probe:slack` (7.4): only one of the two is open
      afterwards, in each direction.

## 4. Settings dialog and sections (design D1, D2, D4, D5, D9)

- [x] 4.1 Replace `settings/TerminalFontDialog.tsx` with `settings/SettingsDialog.tsx`. It has:
  - a fixed size;
  - a vertical tab list and a panel;
  - an `initialSection` prop;
  - the last section remembered for the run.

  It keeps `aria-label={t('settings.title')}`. Verify with `probe:workspace` (7.2).
- [x] 4.2 Sections under `settings/sections/`, each writing through the queue, with inline failures (`role="alert"`,
      dictionary text only, the raw error to the console) and the D2 field rules:
  - `GeneralSection`;
  - `TerminalSection` (family, size, line height, the preview directly after them, GPU);
  - `AgentsSection` (agent status, auto-hibernate, the view radio group);
  - `AboutSection` (`BuildIdentity` moved).

  Verify with 7.1 and 7.2.
- [x] 4.3 Restore defaults for Terminal and Agents & sessions, with an inline confirmation that Esc cancels. Verify
      with `probe:terminal` (7.1).
- [x] 4.4 Dictionary (`en.json`, `zh-TW.json`):
  - section names, restore/confirm, write-failure messages, the token and port notes, the "not applied" port
    mark, the refused endpoint, and the inbox's Slack line;
  - remove `settings.save` and `settings.reset`, and any key that no code uses afterwards (keep
    `remote.section.*`, see 5.1).

  Verify with `dictionary-completeness.test.mjs`, `i18n-key-safety.test.mjs` and `aria-label-source.test.mjs`.

## 5. Remote access and Slack move into Settings (design D6, D7)

- [x] 5.1 Move `RemoteAccessDialog`'s body to `settings/sections/RemoteSection.tsx`, then delete the dialog.
      Changes:
  - the off / on with devices / failed summary line comes first, under the existing
    `role="group"` / `remote.section.label`;
  - pairing is cancelled on unmount;
  - Revoke asks first;
  - the port applies through "Use port" or Enter, keeps an unapplied value marked, and Esc restores it;
  - the address follows D2 with no button;
  - the section list marks Remote access while the listener failed.

  Verify with `probe:remote` (7.3).
- [x] 5.2 `ActivityBar.tsx`: the connected-device indicator opens Settings on Remote access. Verify with
      `probe:remote` (7.3).
- [x] 5.3 Move `intake/SlackSettings.tsx` to `settings/sections/IntegrationsSection.tsx`. Changes:
  - the look-back follows D2;
  - the endpoint is a draft that commits nothing when empty, shows a refusal, and keeps Reset;
  - tokens save on their button or Enter, never on blur, with the note;
  - the routing hint shows only without a fallback (`intake.rules()`), with a control that closes Settings and
    opens the inbox on Routing rules.

  Verify with `probe:slack` (7.4).
- [x] 5.4 `IntakeOverlay.tsx`:
  - drop the Slack tab and add `initialTab`;
  - show one Slack status line, with a control that opens Settings on Integrations, only while Slack is set up and
    not working.

  Verify with `probe:slack` (7.4).

## 6. Coverage table, control groups, leftovers

- [x] 6.1 `scripts/scenario-coverage.test.mjs`. Verify with `npm test`, including the duplicate-row and
      carrier-label guards.
  - Add `settings-sections` to `COVERED_CHANGES`.
  - Add a row only for each scenario name that is new.
  - Update the carrier and mutation of each kept name.
  - Mark retired names that archived changes still hold with `carrier: null` and "superseded by
    settings-sections": "The section opens the remote access dialog" and the old remote probe labels.
- [x] 6.2 `scripts/slack-control-groups.mjs`: move the `file` and `from` entries to `IntegrationsSection.tsx`.
      Verify with `control-groups-source.test.mjs`.
- [x] 6.3 Grep for leftover references in `src`, `scripts`, `docs` and `site`: `RemoteAccessDialog`,
      `TerminalFontDialog`, `settings.save`, the Slack tab label, and "remote access dialog". Verify that the grep is
      empty, apart from archives and the coverage table's superseded rows.

## 7. Probes (design D10)

- [x] 7.1 `scripts/lib/settings.mjs` (`openSettings`, `setField`, `awaitApplied`). Then:
  - `probe:terminal` (the Save presses at ~854 and ~4747) moves to the helpers;
  - `probe:package` and `probe:package-mac` show About before reading the build identity.

  Add the `terminal-preferences` scenarios:
  - a choice applies with Settings open;
  - a typed size applies on blur and not while typing;
  - Esc reverts an unapplied field;
  - unparseable text is rejected;
  - a clamped value is shown;
  - choosing a family does not apply a typed size;
  - two quick font changes both persist on screen and on disk. The size field's blur and the family's change are
    dispatched in one `evaluate`, so the second write is queued before the first returns;
  - a failed write is shown and leaves nothing behind (a directory at `<userData>/preferences.json.tmp`);
  - restore per section, declined, and Esc.

  Controls:
  - committing on every keystroke turns "not while typing" red;
  - a pre-bound queue turns "two quick font changes" red.

  Verify that `npm run probe:terminal` is green with both controls red.
- [x] 7.2 `probe:workspace`:
  - the Save press at ~1818 moves to the helpers;
  - Settings lists the six sections, keeps its size, and reopens on the last section;
  - the preview comes directly after the font fields;
  - the view radio shows the current view, and choosing the terminal view switches every agent session.

  Verify that `npm run probe:workspace` is green.
- [x] 7.3 `probe:remote`: drive the Remote access section instead of the dialog. Add:
  - the summary line is in the section;
  - leaving the port field does not move the listener;
  - declining a revoke keeps the device;
  - leaving the section invalidates a pairing code;
  - the indicator opens Settings on the section;
  - a port in use marks the section in the list.

  Verify that `npm run probe:remote` is green.
- [x] 7.4 `probe:slack`: drive Integrations. Add:
  - a token is not stored on blur;
  - the look-back is stored once as a two-digit value;
  - an `http:` endpoint is refused and the custom one stays;
  - an empty endpoint draft changes nothing;
  - the fallback hint follows the fallback, and its control opens Routing rules;
  - the inbox has no Slack tab and no rules editor in Settings;
  - an invalid credential puts the Slack line in the inbox, and a working one does not;
  - the line's control leaves Settings open on Integrations and the inbox closed.

  Verify that `npm run probe:slack` is green.
- [x] 7.5 `probe:intake`: a notification while Settings is open leaves only the inbox open. Adjust any step that
      reached the Slack tab. Verify that `npm run probe:intake` is green.
- [x] 7.6 Finally, verify that `npm run test:e2e` is green with every probe complete. Ran: 13 of 14 green, every
      probe complete. The one red check (`probe:openspec`, change-view keyboard tab scrolling) fails on the commit
      before this change too; this change does not fix it, it is issue #89. `probe:intake`'s intermittent
      accepted-items failures likewise predate it, issue #90.

## 8. Documentation

- [x] 8.1 Website, in English and Traditional Chinese. Verify with `(cd site && npm ci && npm run build)`.
  - `reference/settings.md`: sections, apply-on-change, restore.
  - `using/remote-access.md`: Settings section, revoke confirmation.
  - `using/inbox-and-slack.md`: Slack in Integrations, rules in the inbox, the inbox's Slack line.
  - `reference/data-and-network.md`: where Slack credentials are saved.
  - `using/terminals-and-sessions.md`: the path to Settings.
  - `using/conversation-view.md`: the view is also in Settings.
- [x] 8.2 `docs/remote-protocol.md`: "the desktop's remote access dialog" becomes the remote access section of
      Settings. `scripts/remote-protocol-doc.test.mjs` must stay green.
- [x] 8.3 `CLAUDE.md`, "現況": one line on the Settings sections, the single save model, and Slack and remote access
      living there. Verify by reading the diff.
- [x] 8.4 Screenshots: re-run `npm run capture:screenshots` only if a captured shot shows Settings or the inbox's
      tabs (`inbox` shows the tab strip). Verify that the manifest test passes.
