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
- listing, accepting and ignoring inbox items;
- reading handoff state and a handoff's brief;
- reading OpenSpec changes, change details and specs;
- watching the attention stream, resuming from the last event received (see `remote-notifications`).

Writing or deleting files, changing settings, reading the Slack configuration, reading any credential, and
changing a terminal's size SHALL NOT be operations. The one exception to "writing files" is an uploaded
attachment. It is written only into the desktop's attachment store, under a name the desktop chooses
(`remote-attachments`). No operation SHALL take a path or a directory from the device.

#### Scenario: An unknown operation is refused without effect

- **WHEN** an authenticated client invokes an operation name that is not on the list, such as one that writes a file
- **THEN** the response is an error naming the operation as unknown, and the connection stays open

#### Scenario: A failed operation keeps the connection

- **WHEN** an authenticated client watches a session id that does not exist
- **THEN** the response is an error with a not-found code, and a following valid operation succeeds on the same connection

### Requirement: With no window, session operations are refused rather than opening one

While the application has no window, creating, waking, renaming and accepting SHALL be refused with an error
stating that no window exists. The application SHALL NOT open a window for them.

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

#### Scenario: Reloading the interface ends remote watches and keeps the connection

- **WHEN** a client watches a session's terminal, and the window's interface reloads
- **THEN** the client is told the watch ended, and its connection is still open

## ADDED Requirements

### Requirement: The watched conversation states the open prompt and whether a device may answer it

While a watched agent waits on a choice and a permission request is open (`agent-event-bridge`), the wait
updates sent to the client SHALL carry the first open request with its identity and the number of open
requests. The request is one of:

- **a permission prompt**: the tool and its identifying argument, and whether a device may allow it once.
  Allowing once SHALL be offered only for tools whose prompt was measured to put a one-time approval first
  (the command, file edit, file write, file read and web fetch tools). It SHALL NOT be offered for any other
  tool.
- **a plan approval**: the plan's text when the agent wrote one, and the approvals a device may choose.
  With a plan, they are "approve, asking before each edit" and "approve and switch to auto mode". Without
  one, the only approval is "leave plan mode, asking before each edit". Allowing once SHALL NOT be offered
  for it, because its first option starts a mode that approves later actions.
- **a question**: its questions, each with its header, its options (label and description) and whether
  several may be chosen.

The update SHALL also say whether a device may answer. It may only when:

- exactly one request is open;
- no keystroke was written to the session since the request's tool call started;
- the request's agent reported no other tool start or finish since then;
- no device answer was written to it yet;
- for a question, there are one to four questions, each with one to eight options.

A keystroke is any write to the session except a device answer's own keys and the terminal's focus and mouse
reports: the keyboard, a client's terminal input, a reply, and the desktop's own prefills.

The update SHALL be sent whenever the prompt, the number of open requests or whether a device may answer
changes, also when no agent event caused the change.

When no request is open, the update SHALL carry no prompt. The existing pending request (tool and argument)
SHALL be sent as before.

**Reason**: the terminal's options for a permission prompt are not in the agent's request, and their number
and meaning differ by tool and by the user's settings (measured, CLI 2.1.300). A question's options are in the
request. Several prompts can be open at once, and only the first is on screen.

The desktop's conversation view still offers no answering (`agent-input-bridge`), because it would depend on
the terminal's numbering. A device's answer depends on it too, but only within what was measured:

- the first option of the listed tools is a one-time approval;
- dismissing a prompt;
- the question tool's option numbering.

The answer is also checked against the agent's record where one exists.

#### Scenario: A permission prompt is stated with its answers

- **WHEN** a client watches an agent that asks permission to run a command
- **THEN** the client receives a wait update whose prompt names the command tool and its argument, carries an identity, offers allowing once, and is answerable

#### Scenario: A plan approval is stated with the plan and its approvals

- **WHEN** a client watches an agent that asks for approval of a plan it wrote
- **THEN** the prompt the client receives carries the plan's text, offers both approvals and denying, and does not offer allowing once

#### Scenario: A question is stated with its options

- **WHEN** a client watches an agent that asks two questions, the second allowing several choices
- **THEN** the prompt the client receives carries both questions with their options in order, marks the second as allowing several choices, and is answerable

#### Scenario: Two open requests are not answerable

- **WHEN** a client watches an agent with two open permission requests
- **THEN** the prompt the client receives names the first, says two are open, and is not answerable

#### Scenario: A prompt the desktop typed into is not answerable

- **WHEN** a permission request is open, the agent reports nothing more, and a key is typed into the session on the desktop
- **THEN** the client receives a wait update that says the prompt is not answerable

### Requirement: A device's answer reaches only the prompt it was given and never submits text

Answering SHALL be accepted only for the conversation the connection watches, and only with the identity of
the open request. The answer SHALL be one of:

- allow once, where offered;
- for a plan approval, one of the approvals it offers;
- deny (for a question, decline; for a plan approval, keep planning);
- for an answerable question, one choice per single-choice question and one or more distinct choices per
  several-choice question.

Anything else SHALL be refused, and nothing SHALL be written.

The desktop SHALL write the answer to the session as the keys a user would press, one key at a time, with a
pause between keys. Immediately before each key, it SHALL read the agent's events again. It SHALL write the
key only while:

- exactly one request is open;
- it has the answer's identity;
- no keystroke was written to the session since that request's tool call started;
- the request's agent reported no other tool start or finish since then;
- no other answer was written to it.

Then:

- When the first key is withheld, the answer SHALL be refused with an error stating the prompt is gone.
- When a later key is withheld, the remaining keys SHALL NOT be written, and the answer SHALL be reported as
  partial.
- For a question, the desktop SHALL compare the answers the agent records with the choices sent. For a plan
  approval, it SHALL compare the permission mode the agent reports next with the one chosen. It SHALL report
  either as confirmed or as differing. With no record within three seconds, it SHALL report the keys as sent.
- After a denial the desktop writes, the request SHALL no longer be open (`agent-event-bridge`).

No answer SHALL include the submit key. Answers and replies to one session SHALL be written one at a time.

**Reason**: text and the submit key typed into an open prompt approve it (`companion-test-fixes`), so an
answer must not be text.

- The agent waits for its tool-start event before showing any prompt. It reports each queued request before
  that request's own prompt is shown, and shows queued prompts in the order reported (measured, CLI 2.1.300).
  A prompt that replaced the one being answered, or one queued behind it, is therefore known before the next
  key.
- A prompt answered or dismissed on the desktop reports nothing until its tool ends, or nothing at all. The
  key the user pressed is what tells it.
- A request dismissed in some other way can still be answered. The keys then reach the agent's input box,
  where none of them submits anything, or interrupt a working agent (Esc). The protocol document SHALL state
  this.

#### Scenario: Allowing a command from a device

- **WHEN** a client answers the open command prompt of its watched agent with allow once
- **THEN** the session receives that prompt's first-option key and no submit key, and the answer is reported as sent

#### Scenario: An answer to a prompt that was replaced is refused

- **WHEN** the agent's prompt is answered on the desktop, the agent then asks permission for another tool, and a client answers the first prompt's identity
- **THEN** the answer is refused as gone, and nothing is written to the session

#### Scenario: An answer after the desktop typed is refused

- **WHEN** a permission request is open, a key is typed into the session on the desktop, and a client answers that request
- **THEN** the answer is refused as gone, and nothing is written to the session

#### Scenario: A second answer to the same prompt is refused

- **WHEN** a client allowed a command whose tool is still running, and an answer to the same prompt arrives
- **THEN** it is refused as gone, and nothing is written to the session

#### Scenario: An answer while two requests are open is refused

- **WHEN** two permission requests are open and a client answers the first one's identity
- **THEN** the answer is refused as gone, and nothing is written to the session

#### Scenario: A question is answered with the option keys

- **WHEN** a client answers a two-question prompt, choosing the second option of a single-choice question and the first and third of a several-choice question
- **THEN** the session receives, one key at a time, the second option's key, the first and third options' keys, the key that moves past the question, and the confirmation key, and no submit key

#### Scenario: A question's answer is confirmed against the agent's record

- **WHEN** a client answers a question and the agent records the chosen labels as the answer
- **THEN** the answer is reported as confirmed

#### Scenario: An answer interrupted by the prompt ending is partial

- **WHEN** a client's multi-key answer is being written and, before the last key, the agent reports another permission request
- **THEN** the remaining keys are not written, and the answer is reported as partial

#### Scenario: Allowing where it is not offered is refused

- **WHEN** a client answers the plan approval with allow once
- **THEN** the answer is refused as not answerable from a device, and nothing is written

#### Scenario: Approving a plan from a device asks before each edit

- **WHEN** a client approves its watched agent's plan with the approval that asks before each edit
- **THEN** the session receives that option's key and no submit key, and when the agent next reports the default permission mode the answer is reported as confirmed

#### Scenario: A plan approval that lands in another mode is reported

- **WHEN** a client approves a plan with auto mode, and the agent next reports a mode other than auto
- **THEN** the answer is reported as differing

#### Scenario: After a device's denial the agent takes a reply

- **WHEN** a client denies the agent's only open prompt
- **THEN** the session receives the dismiss key, the wait state becomes ready, and a reply from the client is accepted

### Requirement: A device renames a session with the desktop's naming rule

Renaming SHALL be carried out by the window's interface through the desktop's own rename, under the naming
order of `terminal-sessions`. A non-empty name SHALL become the session's name. An empty name, or one that
is empty once trimmed, SHALL clear the session's name, so the label follows that order again. Control
characters SHALL be removed and the name SHALL be clipped to 200 characters before it is applied. A dormant
session SHALL be renameable.

Renaming SHALL NOT move the rail selection, change any item's focused session or take keyboard focus. The new
label SHALL reach clients through the session list. An unknown session SHALL be refused as not found, and an
interface that does not answer within fifteen seconds SHALL time out.

#### Scenario: Renaming from a device changes the label everywhere

- **WHEN** a client renames an agent session
- **THEN** the desktop's tab and rail show the new name, the session list the client receives carries it, the rail selection and keyboard focus are unchanged, and the name is restored after an application restart

#### Scenario: An empty name hands naming back

- **WHEN** a client renames an agent session that was not created by a handoff and has a name, to an empty name
- **THEN** the session's label is the agent's latest title again

### Requirement: The authentication answer lists the operations the desktop accepts

The answer to a successful authentication, by credential or by pairing, SHALL list the operations this
desktop accepts, other than authentication itself. A client SHALL be able to rely on it to decide which
controls to show. Additions within protocol version 1 SHALL be new fields, operations, events and error
codes, which a client ignores when it does not know them.

#### Scenario: The answer lists the new operations

- **WHEN** a paired device authenticates
- **THEN** the answer lists the operations the server accepts, including renaming, uploading an attachment and answering a prompt, and does not list authentication operations
