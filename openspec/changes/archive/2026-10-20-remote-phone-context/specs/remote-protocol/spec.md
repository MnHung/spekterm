## ADDED Requirements

### Requirement: A prompt submitted from a device tells the agent it came from the user's phone

When the desktop writes the submit key for a device — for a reply (`conversation.send`) or for a filled-in prompt
(`sessions.submitPrefill`) — the agent SHALL receive, with that one prompt submission, a note that the user sent it
from their phone and will read the answer there, so that it keeps the answer suited to a small screen. The note SHALL
reach the agent **outside the message**, as context of the submission, and SHALL NOT be part of:

- the text written into the session, and so not of a reply's reported text (`r.text`);
- the message the agent records, and so not of the conversation either the desktop or a device shows;
- what the session's terminal shows.

The desktop SHALL arm the note only immediately before it writes the submit key for a device, and the first prompt
submission the agent reports after that SHALL take it. A reply whose submit key is withheld SHALL NOT arm it. A note no
submission took SHALL lapse within 10 seconds of being armed.

A prompt submitted any other way — typed at the desktop, written by the desktop for an agent's handoff, or typed
through a device's raw terminal input — SHALL NOT carry the note, **except** when it is the first submission the agent
reports within 10 seconds of a note armed and not yet taken (a device's submit key that did not take, or a device's
submission the agent does not report). A submission the agent reports for something the user did not type, such as a
background task's notice, may take a note armed just before it; the device's prompt then goes without it. The first
prompt typed at the desktop after a device's note was taken SHALL NOT carry it.

When the note cannot be given — the session's agent has no event reporting, or its process was started without the
hook that carries the note — the reply SHALL be written and submitted exactly as without this requirement. Giving the
note SHALL NOT block, delay or change a prompt.

The protocol document SHALL say, for `conversation.send` and `sessions.submitPrefill`, that the desktop tells the agent
outside the message that it came from the user's phone, and that a client does nothing for it.

#### Scenario: A reply from a device reaches the agent with the note

- **WHEN** a client watches an agent session whose agent waits for input, replies with a text, and the reply is submitted
- **THEN** the agent's prompt-submission hook for that prompt yields the note, and the conversation entry for the reply equals the reply's reported text

#### Scenario: The next prompt typed at the desktop carries no note

- **WHEN** a device's reply was submitted and taken, and the user then types a prompt at the desktop and presses Enter
- **THEN** the agent's prompt-submission hook for the desktop's prompt yields nothing

#### Scenario: A withheld submit key arms nothing

- **WHEN** a device's reply is answered as filled in and not submitted, because the agent began waiting on a choice during the delay, and the user later submits that text at the desktop
- **THEN** the agent's prompt-submission hook for it yields nothing

#### Scenario: Sending a filled-in prompt from a device carries the note

- **WHEN** a device sends a session's listed filled-in prompt and the agent starts on it
- **THEN** the agent's prompt-submission hook for it yields the note

#### Scenario: A note no submission took lapses

- **WHEN** the desktop armed the note for a session, no prompt submission took it, and more than 10 seconds later the user submits a prompt at the desktop
- **THEN** the agent's prompt-submission hook for it yields nothing

#### Scenario: A note that cannot be armed does not stop the reply

- **WHEN** a device replies to an agent session and the desktop cannot arm the note (its file cannot be written)
- **THEN** the reply is written and submitted, and answered as submitted

### Requirement: A watched conversation carries the agent's reported model and usage

While a client watches an agent session's conversation, it SHALL receive that session's model and usage as the
session's agent last reported them through the status bridge (`claude-status-bridge`): the model's display name, the
effort level, the context used as a percentage and the context window's size, the session's cost, and the five-hour
and seven-day rate limits with their reset times. Each value SHALL be present only when the agent reported it; nothing
else from the agent's report SHALL be sent — no path, no working directory, no transcript location.

The desktop SHALL send these values once when the watch starts — with no value at all when the agent has reported
none — and again whenever one of them changes while the watch lasts, within about 2 seconds of the agent's report. It
SHALL NOT send them when nothing changed, and SHALL NOT carry them in the session list.

The protocol document SHALL describe the event, each value and its unit, that every value may be absent (status
reporting off, a status line that could not be chained, nothing reported yet, or an older desktop), and that rate
limits are the account's as this session's agent last reported them.

#### Scenario: A watch starts with the reported values

- **WHEN** an agent session's agent reported its model, context and cost, and a client watches its conversation
- **THEN** the client receives the model's display name, the context percentage and window size, and the cost, and no path

#### Scenario: A new report reaches the watching client

- **WHEN** a client watches an agent session and its agent then reports a higher context percentage
- **THEN** the client receives the new percentage within a few seconds, without a new session list

#### Scenario: No report means no values

- **WHEN** a client watches an agent session whose agent has reported nothing
- **THEN** the client receives the event with no model, context, cost or rate-limit value

#### Scenario: Nothing is sent when nothing changed

- **WHEN** a client watches an agent session and the agent's report does not change for ten seconds
- **THEN** the client receives no further usage event in that time

### Requirement: A watched conversation carries the skills its agent can invoke

While a client watches an agent session's conversation, it SHALL receive the skills the session's agent was told it
can invoke, as the agent recorded that listing in the transcript being followed: each skill's name and its
description (none when the listing gives none), in the listing's order. A listing the agent marks as initial SHALL replace the list. A later
listing SHALL change the list as the agent meant it — re-listing the skills, or naming new or changed ones — as far as
the listing's own fields and the agent's measured behavior tell those apart; where they do not, the protocol document
SHALL state how the desktop reads such a listing and what that reading misses (a removed skill still listed, or
listed skills dropped). The listing SHALL be parsed by white-list: a record of another shape SHALL be ignored, never
shown as a skill.

The desktop SHALL send the list after the watch first reads the transcript and whenever it changes. When the
transcript followed holds no listing — a session that has not received a message yet, or one whose agent moved to a
new transcript — it SHALL send that no list is known, which a client SHALL NOT show as an empty list. Built-in
commands of the agent's command line, and skills only the user may invoke, are not part of the list.

A reply whose text starts with `/` SHALL be written trimmed, with the whitespace after the command's name made one
space, so that its reported text is the line the conversation shows for it.

The protocol document SHALL describe the event, its "no list known" value, that a skill is invoked by sending
`/name` or `/name arguments` as a reply, how that behaves as measured with the agent (or the rule the desktop applies
to it), and that a description is shown as plain text.

#### Scenario: The client receives the agent's skills

- **WHEN** an agent session's transcript holds the agent's skill listing, and a client watches its conversation
- **THEN** the client receives each listed skill's name and description, in the listing's order

#### Scenario: A later listing adds a skill

- **WHEN** a client watches the conversation, and the agent records a further listing that is not marked initial and names only a skill not listed before
- **THEN** the client receives a list holding the earlier skills and the new one

#### Scenario: No listing is not an empty list

- **WHEN** a client watches an agent session whose transcript holds no skill listing
- **THEN** the client receives that no list is known

#### Scenario: A skill sent from the device is confirmed

- **WHEN** a watching client sends `/name arguments` as a reply for a listed skill, and the agent runs it
- **THEN** the conversation shows a user entry equal to the reply's reported text

#### Scenario: A slash reply with extra spaces is written in the shown form

- **WHEN** a watching client sends `/name   arguments  ` as a reply
- **THEN** the reply's reported text is `/name arguments`, and that is what was written before the submit key
