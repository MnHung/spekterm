## ADDED Requirements

### Requirement: Submitting a prompt and a failed tool make the agent busy; a failed turn makes it ready

The injected event reporting SHALL also cover three more moments:

- the user submits a prompt, which SHALL set the wait state to busy;
- a tool fails, which SHALL set it to busy;
- a turn ends because the agent's requests kept failing, which SHALL set it to ready. When a subagent
  reports such a failure instead of the agent itself, the state SHALL be unknown, not ready: whether
  subagents report it was not measured, and a subagent's failure can arrive while the agent waits on a
  choice, where ready would allow sending into the prompt.

**Reason**:

- Without the submission event, an agent writing a text-only answer is never busy: busy came only from tool
  use, so the state read ready for the whole answer.
- Without the tool-failure event, an approved tool that fails leaves the state on awaiting-choice until the
  turn ends. The agent reports a failed tool differently from a finished one, and no reply can be sent
  while the state is awaiting-choice.
- Without the failed-turn event, a turn whose requests failed would read busy until the idle notice a minute
  later. The turn-end event is not sent for a failed turn.

Measured (CLI 2.1.300):

- prompt submission is reported at submission, also mid-turn and during a text-only answer;
- it is not reported for local commands (`!` input, `/cost`, `/clear`), so none of them leaves the state
  busy;
- text typed into an open permission prompt or question is not a submission: that text and Enter answer
  it. So this event cannot move the state out of awaiting-choice while a prompt is open;
- with the agent's service unreachable, the failed-turn event arrived after the agent's retries ran out
  (about three minutes), and the idle notice a minute after that.

**Known gaps**, for which the agent reports no event:

- A message queued during a text-only answer is reported when it is submitted. When the first answer ends,
  the state reads ready until the agent starts answering the queued message (measured 1.8 s).
- An interrupted turn sends no event (measured: none in 70 s). The state stays what the turn last reported,
  typically busy, until the next event, usually the user's next prompt.
- A subagent's tool event can arrive after the turn ended. The state then reads busy until the next event.

#### Scenario: A text-only answer shows the agent busy

- **WHEN** the user submits a prompt and the agent answers with text only, using no tool
- **THEN** the wait state is busy from the submission until the agent reports it finished

#### Scenario: A failed tool leaves the choice

- **WHEN** the agent asks to use a tool, the user approves, and the tool fails
- **THEN** the wait state leaves awaiting-choice when the failure is reported

#### Scenario: A failed turn makes the agent ready

- **WHEN** the agent is busy and reports that its turn ended because its requests failed
- **THEN** the wait state is ready

#### Scenario: A subagent's failed turn does not make the agent ready

- **WHEN** the agent waits on a choice and a subagent reports that its turn ended because its requests failed
- **THEN** the wait state is unknown, not ready

### Requirement: A pending choice keeps what it asks about until the choice ends

While the wait state stays awaiting-choice, the request presented as pending (the tool and its identifying
argument) SHALL stay the one the agent's request named. An event that names no tool SHALL NOT replace it,
and neither SHALL a check that finds no new event or no event location. The pending request SHALL clear
when the state leaves awaiting-choice, and a new request that names a tool SHALL replace it.

**Reason**: the agent's own notice of the same prompt arrives about six seconds after the request and names
no tool (measured, CLI 2.1.300). The state is also checked several times a second, mostly finding nothing
new.

#### Scenario: The prompt's later notice does not erase the tool

- **WHEN** the agent asks to use a tool, and its notice of the same prompt arrives in a later check
- **THEN** the pending request still names the tool and its argument

#### Scenario: A view opened during the prompt shows the tool

- **WHEN** the agent asks to use a tool, several checks find no new event, and then the conversation view is opened
- **THEN** the view shows which tool is asking

#### Scenario: The next request replaces the pending one

- **WHEN** a pending request is answered and the agent then asks to use another tool
- **THEN** the pending request names the new tool

### Requirement: A denied permission prompt is a known blind spot

When the user denies a permission prompt, by dismissing it or by choosing to refuse, the agent reports no
event at all (measured, CLI 2.1.300: none within 70 seconds, no turn end and no idle notice). The wait state
therefore SHALL stay awaiting-choice until the next event, typically the user's next submitted prompt. This
is a known limitation of the agent's event reporting. The state SHALL NOT be inferred from the terminal
screen.

#### Scenario: Typing after a denied prompt recovers the state

- **WHEN** the user denies a permission prompt and then submits a prompt in the terminal
- **THEN** the wait state leaves awaiting-choice
