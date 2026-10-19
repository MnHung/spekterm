## ADDED Requirements

### Requirement: A device sees a filled-in prompt waiting to be sent, and sends it as the user's Enter

The session list SHALL carry, on a running agent session, the prompt the desktop filled into its input box and
shows as waiting to be sent, as `prefill`: the exact text written, the inbox item it came from, an identity for
that one fill, and whether the input box may hold more than that text (`edited`). The field SHALL be present
exactly while:

- the desktop has not seen the prompt submitted (the agent has not started working since it was written);
- the desktop shows the session's "not sent" label for it — for a third-party prompt from the moment it is
  written; for a prompt the desktop submits itself, only once the desktop fell back to that label because the
  agent did not start;
- the inbox item it came from is still listed for that session (accepted into it, not cleared).

`edited` SHALL be true when a keystroke, as `pty-input` defines it, happened after the fill, or before it at any
time since the session's current process started (no event says the input box is empty, and text already in it
ends up in front of the prompt). The desktop's own
writes for the fill — the text, its own submit key, and the key written by the submit operation below — SHALL NOT
count. Each fill SHALL get its own identity. A change of the field — a prompt filled in or offered, sent, typed
over, its item cleared, or its session ended — SHALL be sent to connected clients as a new session list.

Submitting SHALL be an operation that names the session and the fill's identity and writes **only the submit
key**. It is the user's submit that `agent-intake` reserves to the user, made from the device. It SHALL write
nothing, and SHALL be refused with a stable code, when:

- the desktop has no window;
- the session does not exist or has no running process;
- the session has no listed fill, or its listed fill has another identity;
- the listed fill is `edited`;
- the agent's wait state, read again from its events at that moment, is not "waiting for input" — above all
  when it waits on a choice, where the key would choose for the user. A choice the desktop has already read
  counts as the agent having started, so the fill is then no longer listed, and the refusal is the no-fill one.

The checks after the first two and the key SHALL run in the session's queue of device replies and answers, so
none of those is written between the checks and the key.

After the key, the desktop SHALL treat the prompt as submitted by the same rule as an Enter pressed at the
desktop: when the agent starts working, the item is settled and leaves the inbox, the desktop's "not sent"
label goes, and the field leaves the session list. The operation SHALL answer that it was confirmed when the
agent started working within a bounded time, and that the key was only written otherwise; in the latter case
the field stays listed and not edited, and submitting again is allowed.

The prompt's text MAY contain a desktop path and the fill's nonce. Neither is new to a paired device, which
already watches the agent's screen and receives desktop paths in reply results.

The protocol version SHALL stay 1. The protocol document SHALL describe the field, the operation and its
error codes, and SHALL add a client obligation: submit only on the user's explicit action for that session,
after showing the full body of the item the field names and the prompt's text, both as plain text; never as
part of accepting, never automatically, never from a notification; and show an edited fill as one to finish at
the desktop. This repository has no carrier for that obligation. It falls to the client.

#### Scenario: A device's accept of a third-party item lists the filled-in prompt

- **WHEN** a client accepts a pending third-party inbox item into a folder, and the new session's agent becomes ready
- **THEN** the client receives a session list in which that session carries `prefill` with the exact text written to its input, the item's adapter and id, and `edited` false
- **AND** no submit key has been written to that session

#### Scenario: Submitting from a device sends the prompt and settles the item

- **WHEN** a client submits that session's fill by its identity, while the agent waits for input
- **THEN** the session receives one write consisting of the submit key alone, and the agent starts working
- **AND** the answer says it was confirmed, the item is no longer in the inbox list, and the session list no longer carries `prefill` for that session

#### Scenario: Submitting while the agent waits on a choice writes nothing

- **WHEN** a session holds a filled-in prompt and its agent's wait state, read at the moment of the submit, is waiting on a choice
- **THEN** the answer is a wait-state error naming the state, and nothing is written to the session

#### Scenario: Submitting after something was typed is refused

- **WHEN** something was typed into a session after its prompt was filled in, and a client submits the fill
- **THEN** the session list carries `prefill` with `edited` true, the answer is the typed-into error, and nothing is written to the session

#### Scenario: Text typed before the fill marks it edited

- **WHEN** an item is accepted again into a session that is waiting for input and into which the user typed after its process started, and the prompt is filled in
- **THEN** the session list carries `prefill` with `edited` true, and submitting it is refused with the typed-into error

#### Scenario: Submitting a fill that is not the current one is refused

- **WHEN** a client submits a session's fill naming an identity that is not the one listed, or names a session with no fill
- **THEN** the answer is the no-fill error, and nothing is written to the session

#### Scenario: Clearing the item at the desktop withdraws the fill

- **WHEN** the user clears an accepted item at the desktop while its prompt is still filled in and not sent
- **THEN** the session list no longer carries `prefill` for that session, and submitting the fill is refused with the no-fill error

#### Scenario: Submitting with no window is refused

- **WHEN** the desktop has no window, and a client submits a fill
- **THEN** the answer is the no-window error, and nothing is written

#### Scenario: Sending at the desktop withdraws the field

- **WHEN** a session listed with `prefill` has its prompt sent with Enter at the desktop while a client is connected
- **THEN** the client receives a session list in which that session no longer carries `prefill`

#### Scenario: The desktop's own submit of a first-party prompt is not listed as waiting

- **WHEN** an agent's handoff opens a session and the desktop submits its prompt, and the agent starts working
- **THEN** no session list sent from the session's creation until its handoff reports completion carries `prefill` for that session

## MODIFIED Requirements

### Requirement: Operations are an allow-list with named errors

An authenticated connection SHALL be able to invoke only the operations this capability names. Any other
operation SHALL be answered with an error naming it as unknown and SHALL have no effect. Every failure SHALL
be answered with a stable error code and a message. The connection SHALL stay open after an operation
fails.

The operations are:

- listing folders and sessions;
- watching a session's conversation, replying to it (with attachments, see `remote-attachments`), and
  answering its open prompt;
- uploading an attachment (see `remote-attachments`);
- watching a session's terminal output, and sending it input;
- creating a session;
- waking a dormant session;
- renaming a session;
- hibernating a running session;
- closing a session;
- keeping a session whose agent offered to close it (withdrawing the offer);
- listing, accepting and ignoring inbox items;
- submitting the prompt the desktop filled into a session and left unsent;
- reading handoff state and a handoff's brief;
- reading OpenSpec changes, change details and specs, and watching one folder's OpenSpec for changes;
- watching the attention stream, resuming from the last event received (see `remote-notifications`).

Writing or deleting files, changing settings, reading the Slack configuration, reading any credential, and
changing a terminal's size SHALL NOT be operations. The one exception to "writing files" is an uploaded
attachment. It is written only into the desktop's attachment store, under a name the desktop chooses
(`remote-attachments`). Closing a session removes that session's attachments, as closing it on the desktop
does. No operation SHALL take a path or a directory from the device.

#### Scenario: An unknown operation is refused without effect

- **WHEN** an authenticated client invokes an operation name that is not on the list, such as one that writes a file
- **THEN** the response is an error naming the operation as unknown, and the connection stays open

#### Scenario: A failed operation keeps the connection

- **WHEN** an authenticated client watches a session id that does not exist
- **THEN** the response is an error with a not-found code, and a following valid operation succeeds on the same connection

### Requirement: The session list reflects the desktop's sessions

Listing SHALL return:

- the workspace folders, with id, name, branch, pinned state and whether they have OpenSpec, in rail order;
- every session of the window, with id, folder (or the global item), target (agent or shell), label,
  whether it is running, the agent's wait state for agent sessions, its handoff lifecycle state and
  lineage where it has them, whether its agent's close of itself is offered to the user, and, for a running agent
  session, the background tasks its agent runs (`agent-event-bridge`) and the filled-in prompt waiting for the user
  to send it ("A device sees a filled-in prompt waiting to be sent, and sends it as the user's Enter").

For an agent session whose wait state is "waits for input", the list SHALL also carry whether that state has been
seen (`session-wait-indicator`): seen when someone looked at the session since its last turn ended (the desktop's
focused window displays it, or a device watches its conversation — watching its terminal output does not count), or
when no turn has ended since its agent started. The field SHALL be present, true or false, whenever the wait state is
"waits for input", and absent otherwise, so that a client can tell this desktop from one that predates the field. It
SHALL become false at every turn end that no one is looking at. The handoff lifecycle state follows the same mark
(`handoff-completion`).

A change to any of these SHALL be sent to connected clients as a new complete list.

While the application has no window, the session list SHALL be empty and SHALL state that no window exists.

#### Scenario: A session created on the desktop appears in the list

- **WHEN** a client is connected and the user creates a session on the desktop
- **THEN** the client receives a session list that contains the new session with its folder and label

#### Scenario: A finished turn is listed as waiting for input

- **WHEN** an agent session's agent works for several seconds and then finishes its turn
- **THEN** the client first receives a session list in which that session is working, and then one in which it waits for input

#### Scenario: A turn that ends unseen is listed as not seen

- **WHEN** a client is connected, does not watch agent session S, S is not displayed in a focused window, and S's
  agent finishes a turn
- **THEN** the client receives a session list in which S waits for input and is not seen

#### Scenario: Watching a session marks it seen

- **WHEN** S is listed as waiting for input and not seen, and the client starts watching S's conversation
- **THEN** the client receives a session list in which S waits for input and is seen

#### Scenario: A terminal watch does not mark a session seen

- **WHEN** S is listed as waiting for input and not seen, and the client starts watching S's terminal output
- **THEN** S is still listed as not seen

#### Scenario: A turn that ends during a watch is seen at once

- **WHEN** the client watches S's conversation and S's agent finishes a turn
- **THEN** the first session list in which S waits for input lists it as seen

#### Scenario: The seen field is absent unless the session waits for input

- **WHEN** the client receives a session list in which an agent session is working, and one with a shell session
- **THEN** neither of those sessions carries the seen field

### Requirement: Replying from a device follows the desktop's sending rules and never submits into a choice

A reply SHALL be accepted only for the conversation that connection is watching, and only while the agent's
wait state permits sending under the same rules as the desktop (`agent-input-bridge`). Otherwise it SHALL be
refused, with the wait state as the reason. Its content SHALL be cleaned of terminal control characters in
the same way.

The submit key SHALL be written separately from the text, after the same delay the prefill path uses, so a
long reply is not taken as a paste whose submit key is lost. Immediately before writing the submit key, the
wait state SHALL be checked again.

- If sending is no longer permitted (the agent began waiting on a choice during the delay), the submit key
  SHALL NOT be written. The reply SHALL be reported as filled in and not submitted, and it SHALL NOT be
  submitted later.
- Replies to one session SHALL be written one at a time, so two replies never interleave.

**While the session holds a filled-in prompt whose submission the desktop has not seen**, whether or not it is
listed to devices and whether or not something was typed into the session since, a reply SHALL be refused with a
code saying so and SHALL write nothing. Otherwise the reply would be typed after a prompt the device user never
saw and submitted together with it. This SHALL be checked when the reply is received, again when its turn in the
session's queue comes, and again immediately before the submit key: a prompt filled in during the delay SHALL
withhold the submit key, and the reply SHALL be reported as filled in and not submitted.

#### Scenario: A reply reaches the agent

- **WHEN** a client watches an agent session whose agent waits for input, and replies with a long text
- **THEN** the agent receives the text, then the submit key at least 400 milliseconds after the text's last character, and the reply appears in the conversation the client watches

#### Scenario: A reply while the agent waits on a choice is refused

- **WHEN** the watched agent waits on a permission choice, and the client replies with text
- **THEN** the reply is refused with the waiting-on-a-choice reason, and nothing is written to the session

#### Scenario: A choice that appears during the delay keeps the submit key back

- **WHEN** a client replies while the agent is working, and the agent starts waiting on a permission choice before the submit key is due
- **THEN** the submit key is not written, and the reply is reported as filled in and not submitted

#### Scenario: A reply to a conversation the connection is not watching is refused

- **WHEN** a client replies to an agent session other than the one it watches
- **THEN** the reply is refused, and nothing is written to that session

#### Scenario: A reply while a filled-in prompt waits is refused

- **WHEN** a client watches an agent session that holds a third-party prompt filled in and not sent, and the client replies with text
- **THEN** the reply is refused with the filled-in-prompt code, and nothing is written to the session

#### Scenario: A reply into a filled-in prompt that was typed over is still refused

- **WHEN** something was typed into a session after its third-party prompt was filled in, its agent waits for input, and a watching client replies
- **THEN** the reply is refused with the filled-in-prompt code, and nothing is written to the session

#### Scenario: A prompt filled in while a reply waits for its submit key keeps the key back

- **WHEN** a client's reply text was written and a prompt is filled into the same session before the reply's submit key is due
- **THEN** the submit key is not written, and the reply is reported as filled in and not submitted

### Requirement: With no window, session operations are refused rather than opening one

While the application has no window, creating, waking, renaming, hibernating, closing, keeping, accepting and
submitting a filled-in prompt SHALL
be refused with an error stating that no window exists. The application SHALL NOT open a window for them.

This is a deliberate exception to "an action that targets the window while none exists first opens one"
(`workspace-app-shell`). That rule serves an action the user takes at the desktop. Here the user is not at
the desktop, and a window opening there unattended would restore and expose its sessions to whoever is.

When the window closes or its interface reloads, every remote conversation and terminal watch on its
sessions SHALL end with it, because nothing the window held outlives it. The connection itself stays open.

#### Scenario: No window refuses creation

- **WHEN** the application has no window, and a client creates a session
- **THEN** the response is an error stating that no window exists, and no window opens

#### Scenario: No window refuses renaming

- **WHEN** the application has no window, and a client renames a session
- **THEN** the response is an error stating that no window exists, no window opens, and the session's stored name is unchanged

#### Scenario: No window refuses hibernating and closing

- **WHEN** the application has no window, and a client hibernates a session, then closes it
- **THEN** both responses are errors stating that no window exists, no window opens, and the session is still persisted

#### Scenario: No window refuses keeping

- **WHEN** the application has no window, and a client keeps a session
- **THEN** the response is an error stating that no window exists, and no window opens

#### Scenario: Reloading the interface ends remote watches and keeps the connection

- **WHEN** a client watches a session's terminal, and the window's interface reloads
- **THEN** the client is told the watch ended, and its connection is still open

### Requirement: Inbox accept from a device follows the desktop's accept

Listing the inbox SHALL return the same items and fields the desktop's inbox shows, including each item's
full body as plain text. Accepting SHALL require a folder chosen by the device user and SHALL be refused
without one.

Accepting SHALL be carried out by the window's interface along the same path as the desktop's accept:

- it reuses the session an earlier accept of the same item left in that folder;
- otherwise it creates a session there, under the rules for device-requested creation above;
- the item's first prompt is then filled in and submitted or left unsent, by the same rule as on the
  desktop (`agent-intake`).

A prompt left unsent SHALL then be sendable from the device only as a separate, explicit operation
("A device sees a filled-in prompt waiting to be sent, and sends it as the user's Enter"). Accepting SHALL NOT
take a parameter that submits it: the accept usually answers before the prompt is filled in, so such a parameter
would have the desktop submit a third-party body later on its own.

If the session cannot be created, the accept SHALL be refused, and the item SHALL stay pending.

Ignoring SHALL have the same effect as the desktop's ignore. Any change to the inbox, made on the desktop or
from a device, SHALL be sent to connected clients as a new complete list and SHALL be reflected in the
desktop's inbox.

The protocol document SHALL require a client to show an item's full body as plain text before it offers to
accept that item, which is the human check `agent-intake` places before acceptance. This repository has no
carrier for that obligation. It falls to the client.

The protocol document SHALL describe, in its accept section, how a device sends a prompt the accept left
unsent.

#### Scenario: Accepting a third-party item from a device opens a prefilled session in the chosen folder

- **WHEN** an inbox item with a third-party body is pending, and a client accepts it into a folder it names
- **THEN** an agent session is created in that folder with the item's first prompt filled in and not sent, and the item is no longer pending

#### Scenario: Accepting again reuses the earlier session

- **WHEN** an item accepted from a device went back to pending because its agent did not become ready within the prefill time limit, and the client accepts it again into the same folder
- **THEN** no second session is created, and the earlier session receives the prompt once its agent is ready

#### Scenario: A creation failure leaves the item pending

- **WHEN** a client accepts an item into a folder in which no session can be created
- **THEN** the response is an error, and the item stays pending

#### Scenario: Accepting without a folder is refused

- **WHEN** a client accepts an inbox item without naming a folder
- **THEN** the response is an error, and the item stays pending

#### Scenario: Ignoring from a device updates the desktop

- **WHEN** a client ignores a pending inbox item
- **THEN** the item no longer appears in the inbox list on the client or on the desktop

#### Scenario: Ignoring on the desktop updates the client

- **WHEN** the user ignores a pending inbox item on the desktop while a client is connected
- **THEN** the client receives an inbox list without that item
