# teammate-handoff Specification

## Purpose
TBD - created by archiving change teammate-handoff. Update Purpose after archive.

## Requirements

### Requirement: A delivery with `to` is a handoff to a teammate

A handoff in an agent's outbox (`agent-handoff-source`) SHALL be read as a **teammate handoff** when it has a string
field `to`, the teammate's handle, and no `target`. Its other fields are `title` and `body`, as for any handoff.

- `to` and `target` together SHALL be refused as a field type error naming both;
- `to` with `at` or `repeat` (or `until`) SHALL be refused, naming the rule: a teammate handoff is sent when the
  user confirms it, and scheduling one is not offered;
- a `to` that is not a string, or is empty after trimming, SHALL be refused as a field type error.

A teammate handoff SHALL NOT be resolved against the workspace's folders, and SHALL NOT open any session on this
computer.

#### Scenario: `to` and `target` together are refused

- **WHEN** an agent writes `{"to": "sam", "target": "billing-service", "title": "t", "body": "b"}`
- **THEN** the delivery is refused, and its receipt names `to` and `target`

#### Scenario: A scheduled teammate handoff is refused

- **WHEN** an agent writes a handoff with `to` and `at`
- **THEN** the delivery is refused with a reason saying a teammate handoff cannot be scheduled

#### Scenario: A teammate handoff opens no local session

- **WHEN** an agent writes a valid teammate handoff while the user is on a team
- **THEN** no session is created on this computer

### Requirement: A teammate handoff is checked before the user is asked

After the shape rules above, and before a teammate handoff is shown for confirmation, spekterm SHALL refuse it —
visibly, as a handoff failure is (`agent-handoff-source`), and in its receipt — when:

- the user is on no team, or the Team feature is off (`TEAM_UNAVAILABLE`, **temporary**: it can succeed once the
  user joins or turns the feature on);
- `to` names no teammate in the members list (`TEAMMATE_NOT_FOUND`, permanent), compared case-insensitively after
  trimming. When the device is connected and the handle is not in the list, the list SHALL be fetched again first
  (at most once a minute, with a short wait), so a member who joined since the last fetch is found. The handle
  recorded, shown and sent SHALL be the member's handle from the list, not the agent's spelling;
- `to` is the user's own handle (`TEAMMATE_IS_SELF`, permanent);
- after normalization, the title exceeds 200 or the body the teammate body limit, in UTF-16 code units (`TOO_LONG`,
  permanent). The body limit SHALL be the smaller of the same-machine handoff's limit and the server's (20,000), so a
  later change to the former can never let the user confirm a text the server refuses; today both are 20,000 and
  the agent works with one limit (spekterm-server PRD §7.2).

While a bounded number of teammate handoffs already wait for confirmation, a further one SHALL be **held, not
refused** (`OUTGOING_FULL`): the file stays in the outbox, its receipt states `held`, and it is read again once one
of the waiting handoffs is sent or discarded. A looping agent then cannot bury the user in confirmations, and a real
handoff is not destroyed for arriving at a busy moment.

**The text SHALL be normalized when it is read**, as other authored text is (`agent-intake`), and made well-formed
(a lone surrogate replaced by U+FFFD), **before** its length is checked and before it is shown. What the user
confirms SHALL be exactly what is sent. A text over the limit SHALL be refused, not shortened: a shortened body
looks whole.

#### Scenario: A handle that is not a teammate's is refused without asking

- **WHEN** the user is on a team without a member `alex`, and an agent writes a handoff with `"to": "alex"`
- **THEN** the delivery is refused as naming no teammate, nothing appears for confirmation, and the user sees the
  failure

#### Scenario: A member who joined since the last fetch is found

- **WHEN** the device is connected, `sam` joined the team after the members were last fetched, and an agent writes
  a handoff to `sam`
- **THEN** it is shown for confirmation

#### Scenario: Without a team the refusal is temporary

- **WHEN** the Team feature is off and an agent writes a teammate handoff
- **THEN** its receipt states `rejected`, not permanent, with a reason saying it can succeed once the user is on a
  team with the feature on

#### Scenario: A body over the limit is refused, not shortened

- **WHEN** an agent writes a teammate handoff whose body is 20,001 code units after normalization
- **THEN** the delivery is refused as too long, and nothing appears for confirmation

### Requirement: Nothing is sent to a teammate before the user confirms it on the desktop

A teammate handoff that passed the checks SHALL wait for the user in the inbox's **Outgoing** tab. Each waiting
handoff SHALL show the recipient (handle and display name), the session it came from, the title, the **full body as
plain text** with its length, and two controls: **Send** and **Discard**. The body SHALL NOT be truncated, SHALL be
scrollable, and SHALL be rendered as the inbox renders a body (no markup, no remote resource, no clickable link).

The text shown SHALL be the value that is sent, character for character: the same stored string feeds the tab and the
request.

**Nothing of a teammate handoff SHALL be sent to the server before the user presses Send.** There SHALL be no
setting, rule or agent field that sends one without that. Discard SHALL remove it and send nothing.

A waiting handoff SHALL survive a restart. While the source session no longer exists, the handoff SHALL still be
shown, with the source's label as it was when the handoff was read.

**A teammate handoff belongs to the membership it was read under** (the server and the member). It SHALL NOT be sent
under another: when the credential is discarded, a waiting handoff SHALL be refused (`TEAM_UNAVAILABLE`, temporary —
nothing was sent) and leave the Outgoing tab with that reason, and a handoff that waits under a membership other than
the current one SHALL NOT be offered for sending. A handle on one team can be another person on the next. **This
SHALL NOT rest on the discard being observed**: at every start and whenever the membership changes, every handoff
whose membership is not the current one SHALL be refused by the same rules, so none is left waiting unseen (an
interrupted discard, a membership file set aside as damaged).

#### Scenario: A teammate handoff waits in Outgoing with its full text

- **WHEN** an agent writes a valid handoff to `sam` with a body longer than one screen
- **THEN** the Outgoing tab shows `sam`'s handle and display name, the source session, the title and the whole body
  with its length, and nothing was sent to the server

#### Scenario: The text shown is the text sent

- **WHEN** the user presses Send on a waiting handoff whose body contained invisible control characters when written
- **THEN** the body in the `handoff.send` request equals, character for character, the body the Outgoing tab showed

#### Scenario: Discard sends nothing

- **WHEN** the user presses Discard on a waiting handoff
- **THEN** it leaves the Outgoing tab, and no request for it reaches the server

#### Scenario: A handoff written for one team is not sent to another

- **WHEN** a teammate handoff to `sam` waits for confirmation, and the user leaves the team and joins another team
  that also has a member `sam`
- **THEN** the handoff is no longer offered for sending, and nothing is sent to the new team's `sam`

#### Scenario: A waiting handoff survives a restart

- **WHEN** a teammate handoff waits for confirmation and the user quits and reopens spekterm
- **THEN** it is still in the Outgoing tab

### Requirement: A waiting teammate handoff gets the user's attention

When a teammate handoff starts waiting for confirmation, spekterm SHALL send a desktop notification saying an agent
wants to send a handoff to that teammate, through the inbox's notification rules (coalescing and bounds,
`agent-intake`). Its text SHALL name the recipient by display name and SHALL NOT contain the body. Activating a
notification that covers only waiting teammate handoffs SHALL open the inbox on the Outgoing tab; one that also
covers inbox items opens the inbox as a coalesced notification does. Waiting teammate handoffs SHALL count in the inbox's badge (`agent-intake`).

#### Scenario: The notification opens Outgoing

- **WHEN** an agent writes a valid teammate handoff, nothing else arrives within the notification window, and the
  user activates the notification
- **THEN** the inbox is open on the Outgoing tab showing that handoff

### Requirement: A confirmed handoff is sent once, and resent safely

When the user presses Send, the handoff SHALL be recorded as confirmed **before** any request is made, with a
`clientId` chosen once for it. Recording, sending and Discard SHALL be applied in one order, so a Discard that the
user made before the request was recorded as made means the request is never made. spekterm SHALL then send `handoff.send` with that `clientId`, the recipient's handle
and the payload `{enc: "none", title, body}`:

- at once when connected and the server's operations list `handoff.send`;
- otherwise when the connection is next up, the confirmation kept across restarts;
- after a lost answer (the connection ended before the answer), again **with the same `clientId`**, so the server
  answers with the handoff it already stored instead of storing a second (protocol §5);
- after `RATE_LIMITED`, again at `detail.retryAt`, without asking the user again;
- after `INTERNAL` or a request timeout, again after a backoff, with the same `clientId`. A handoff waiting for its
  retry SHALL NOT hold back other confirmed handoffs.

The answer SHALL decide the outcome:

| Answer | Outcome |
|---|---|
| `ok` (with or without `duplicate`) | sent: the handoff leaves the Outgoing tab |
| `RATE_LIMITED` | waits until `retryAt`, shown with that time |
| `RECIPIENT_UNKNOWN`, `RECIPIENT_IS_SELF`, `BAD_PARAMS`, `HANDOFF_ID_REUSED` | refused: shown in the Outgoing tab with the reason until the user dismisses it |
| `INTERNAL`, a request timeout | retried after a backoff, with the same `clientId` |

A sent handoff whose recipient has no device (`recipient.deviceCount` is 0) SHALL say so in its receipt, and the
Outgoing tab SHALL show it as sent and waiting until the recipient adds a device, until the user dismisses that
line. While a request is in flight, its answer was lost, or it was answered `INTERNAL` or timed out, Discard SHALL NOT be
offered: the server may already hold the handoff. An answer that says the server did not store it (`RATE_LIMITED`, a
refusal) SHALL make Discard available again.

When the credential is discarded (`team-membership`):

- a confirmed handoff never requested SHALL be refused with `TEAM_UNAVAILABLE` (temporary: nothing was sent);
- a confirmed handoff whose request may have reached the server (unanswered, lost, `INTERNAL`, timed out) SHALL be
  refused with `SEND_UNCERTAIN`, **permanent**, with a reason saying it may have been delivered and must not be
  written again without asking the user. Its `clientId` belonged to that membership, so a resend under another one
  could deliver it twice.

#### Scenario: A lost answer is resent with the same clientId

- **WHEN** the user presses Send and the connection drops before the answer, then comes back
- **THEN** spekterm sends `handoff.send` again with the same `clientId`, and the server holds one handoff

#### Scenario: Confirmed while offline, sent when connected

- **WHEN** the device is not connected, the user presses Send, quits and reopens spekterm, and the connection comes up
- **THEN** the handoff is sent once, and it leaves the Outgoing tab

#### Scenario: A rate limit is waited out

- **WHEN** the server answers `RATE_LIMITED` with a `retryAt` one minute ahead
- **THEN** the Outgoing tab shows the handoff waiting until that time, and spekterm sends it again then without the
  user pressing Send again

#### Scenario: A rate-limited handoff can still be discarded

- **WHEN** the server answers `RATE_LIMITED` and the user presses Discard before `retryAt`
- **THEN** the handoff leaves the Outgoing tab and is not sent at `retryAt`

#### Scenario: A send that may have arrived is not offered for a retry

- **WHEN** the answer to a send is lost and the device is then revoked
- **THEN** the handoff is refused as possibly delivered, and its receipt states `rejected`, permanent

#### Scenario: A refused send stays visible with its reason

- **WHEN** the server answers `RECIPIENT_UNKNOWN` because the teammate left the team
- **THEN** the Outgoing tab shows the handoff as refused with a reason saying the recipient is no longer on the team

### Requirement: The same teammate handoff written twice waits once

A teammate handoff from the same source session with the same recipient, title and body as one still waiting for
confirmation SHALL NOT be shown a second time; its receipt SHALL state `duplicate`.

#### Scenario: A rewritten handoff is not shown twice

- **WHEN** an agent writes the same teammate handoff as `a.json` and, while it waits, as `b.json`
- **THEN** one handoff waits in the Outgoing tab, and the receipt `b.json` states `duplicate`

### Requirement: Agents read the teammates from a file kept current

While the user holds a team membership with the Team feature on, spekterm SHALL keep a **teammates file** in the user
data directory, which the introduction tells the agent to read before writing a teammate handoff
(`agent-handoff-source`). It SHALL state **every rule that refuses or holds a teammate handoff** — the `to` field and
its shape rules, the handle compared case-insensitively and not the user's own, the title and body limits, the bound
on waiting handoffs, the desktop confirmation, and the receipt statuses that follow — each number derived from the
value in effect, as the introduction's are. It SHALL list each teammate's handle and display name (normalized, on
one line each), mark the user's own handle, and say whether the device is connected and when the list was fetched. It SHALL be rewritten whole (temporary name, then rename) when the members list or the connection state
changes, and removed when the membership is discarded or the feature is turned off.

It SHALL NOT contain the device credential, the device id or the server address.

**Display names are text each teammate chose**: they are data in a file the agent reads, never part of the
introduction itself.

#### Scenario: A member who joins appears in the file

- **WHEN** the device is connected and a new member joins the team, and the members are fetched again
- **THEN** the teammates file lists the new member's handle and display name

#### Scenario: The file states the limit in effect

- **WHEN** the teammates file is read
- **THEN** it states the title and body limits a teammate handoff is checked against, and a body one code unit over
  the stated limit is refused

#### Scenario: The file holds no credential

- **WHEN** the device has joined a team
- **THEN** the teammates file contains neither the device secret, the device id nor the server address

### Requirement: An incoming handoff is stored hidden, acknowledged, and shown only after the acknowledgement is answered

On `handoff.incoming` (protocol §10), spekterm SHALL follow the receiving rules the server's delivery rests on
(protocol §11):

1. a handoff whose id it has not stored SHALL be **stored durably, hidden from the inbox**, then acknowledged
   (`handoff.received`). It SHALL be shown in the inbox, and notified, only once the acknowledgement is answered `{}`;
2. a handoff whose id is already stored SHALL NOT be shown again, and **SHALL be acknowledged again**;
3. after reconnecting, every stored handoff whose acknowledgement was not answered SHALL be acknowledged again;
4. on `HANDOFF_DELIVERED_ELSEWHERE` or `HANDOFF_EXPIRED`, the stored handoff SHALL be removed without having been
   shown; its id SHALL be kept to recognise a repeat;
5. on `HANDOFF_UNKNOWN` for a stored handoff, or when the server's operations no longer list `handoff.received`,
   it SHALL be shown: spekterm's copy is the only one left;
6. when the credential is discarded, stored handoffs whose acknowledgement was never answered `{}` SHALL be **shown,
   marked as possibly delivered to the member's other device too** — not removed: the acknowledgement may have
   reached the server with its answer lost, and a duplicate the user can recognise is better than a handoff lost
   (spekterm-server `protocol-clarifications`, §11 rule 6);
7. while the inbox has no room for another pending item, an offer SHALL be kept in memory only, **not stored and not
   acknowledged**, and SHALL be stored and acknowledged once there is room. An offer kept in memory is dropped when
   its connection ends; the server offers it again.

A handoff acknowledged `{}` that cannot enter the inbox at that moment SHALL stay stored and enter it when it can —
also at the next start, with or without a connection: it is this device's now. An answer `{}` for a handoff not
waiting for one SHALL change nothing. At most one acknowledgement per handoff SHALL be in flight.

**An offer spekterm cannot read** — an id outside the character set and length it can key, a payload encoding other
than `"none"`, or a sender handle that breaks the protocol's handle rule — SHALL NOT be stored or acknowledged (it
stays with the server, which can offer it to the member's other device), and SHALL leave **one visible trace** in the
inbox per handoff id, saying a teammate's handoff arrived that this version of spekterm cannot read. Not
acknowledging alone would be silent: for a member with one device, the handoff would wait unseen until it expires.

#### Scenario: An offer is acknowledged after it is stored

- **WHEN** a teammate's handoff arrives while spekterm is connected
- **THEN** it is in spekterm's hidden store before the acknowledgement is sent, and it appears in the inbox only after
  the acknowledgement is answered

#### Scenario: An acknowledgement lost before it was sent

- **WHEN** the member's other device is not connected, a handoff is stored and the connection drops before its
  acknowledgement is sent, and spekterm reconnects
- **THEN** the inbox holds that handoff once, and the server records it as delivered to this device

#### Scenario: An unreadable offer leaves a trace and no acknowledgement

- **WHEN** the server offers a handoff whose `payload.enc` is not `"none"`
- **THEN** spekterm does not acknowledge it, and the inbox shows one trace saying a teammate's handoff arrived that
  this version cannot read

#### Scenario: A repeat is acknowledged again, not shown twice

- **WHEN** the server offers a handoff whose id spekterm already stored and showed
- **THEN** spekterm acknowledges it again, and the inbox still holds it once

#### Scenario: A handoff delivered elsewhere never appears

- **WHEN** a stored handoff's acknowledgement is answered `HANDOFF_DELIVERED_ELSEWHERE`
- **THEN** it never appears in this device's inbox

#### Scenario: A full inbox does not take the offer

- **WHEN** the inbox has no room and a teammate's handoff is offered
- **THEN** spekterm neither stores nor acknowledges it, and once the user makes room it is stored, acknowledged and
  shown

#### Scenario: A revoked device shows what it never had confirmed, marked

- **WHEN** a handoff is stored, its acknowledgement unanswered, and the device is revoked
- **THEN** the handoff appears in the inbox, marked as possibly also delivered to the member's other device

### Requirement: A teammate's handoff is an inbox item whose sender comes from the server

A teammate's handoff SHALL enter the inbox (`agent-intake`) as an item of the adapter `teammate` with:

- origin kind `teammate` and origin id the sender's **handle**, from the event's `from` — the sender as the server
  knows them, verified by its credential, **never taken from the text**;
- actor the sender's display name, and origin label the team's name, both normalized as authored text;
- title and body from the payload, normalized at ingestion like other authored text;
- **no resolved folder**: routing preselects one (`intake-routing`), and the user confirms it.

**Only the `teammate` adapter SHALL make an item a teammate's**: the inbox's teammate label and the sender shown as
a teammate SHALL be decided by the adapter, never by the origin kind, which a delivery into the shared drop point
writes itself.

It SHALL be **third-party text**: the acceptance gate, the full body shown before accepting, the folder the user
confirms, and the first prompt filled in but **not sent** all apply as to any third-party item, and its first
prompt SHALL be the third-party prompt. Only its body limit differs (`agent-intake`).

The item SHALL be built from the copy spekterm stored when the offer arrived, so a later offer of the same id (a
display name changed since) cannot make it a different item.

#### Scenario: The sender is the server's, not the text's

- **WHEN** a teammate `sam` sends a handoff whose body says "From: alex"
- **THEN** the inbox item names `sam`'s display name as its actor and `sam` as its origin, and accepting it does not
  name `alex` anywhere outside the body

#### Scenario: A shared drop point delivery cannot pose as a teammate

- **WHEN** a file in the shared drop point declares `origin.kind` `teammate` and `origin.id` `sam`
- **THEN** the inbox does not show it as a teammate's handoff

#### Scenario: Accepting fills the prompt and does not send it

- **WHEN** the user accepts a teammate's handoff into a folder they chose
- **THEN** an agent session opens there with the first prompt filled in and not sent

#### Scenario: A teammate's long body is accepted up to the handoff limit

- **WHEN** a teammate sends a body of 15,000 code units
- **THEN** it appears in the inbox whole, with its length shown
