## Context

- `/model <name>` on a conversation with content and a warm prompt cache opens a confirmation box in the CLI
  (measured on 2.1.310 by the phone's author, 2026-10-25). It is not a hook event; the wait state is unchanged.
  While it is open, typed text is ignored and the next submit key answers "Yes". Busy or not, it opens at once.
- After "Yes" the transcript gets a `user` record (`<command-name>/model</command-name>…<command-args>x…`, plus
  `<local-command-stdout>Set model to …`); after a cancel or an unknown name, a `system`/`local_command` record
  that the conversation does not show. The statusline payload reruns at once, so `conversation.status` carries
  the new model within about 2 s.
- `/effort <level>` asks nothing and takes effect at once: it needs no desktop work and stays out of scope.
- The CLI binary of 2.1.310 contains a `PreModelSwitch` hook event (checked by string search): the output schema
  is `hookSpecificOutput: { hookEventName: "PreModelSwitch", permissionDecision: "allow" | "deny" | "ask",
  permissionDecisionReason? }`, with `allow` described as "skipping the interactive cache-miss confirm"; the input
  `source` is `command | picker | sdk`. Its **runtime behavior has not been measured** here.
- Prior art: `agent-origin.ts` arms a one-shot mark file before a device's submit key, and an injected
  `UserPromptSubmit` command takes it (atomic `mv`, deadline, always exit 0, print nothing without a mark).

## Goals / Non-Goals

**Goals:** a phone switches an agent session's model without a box nobody can see; a hand-typed `/model x` from
an older phone does not wedge the session either; a switch the user starts at the desktop keeps asking.

**Non-Goals:** a signal for "a confirmation box is open" (there is none and the terminal screen SHALL NOT be
parsed); `/effort`; listing the models a session can use (the phone's own list); the CLI's "saved as your default
for new sessions" side effect (the phone says so; it is the CLI's, and no argument form avoids it).

## Decisions

### D1. Measure the hook first; stop if it does not hold

Task 1 runs a real agent session (throwaway directory, warm cache) and records, with the CLI version: (a) with an
injected `PreModelSwitch` command printing `allow`, `/model <x>` produces no box and the switch happens, while
the agent is idle and while it works; (b) with the hook printing nothing, the box still opens; (c) the exact stdin
JSON (key order, spacing — D3 matches a substring of it), including `source` and `requested_model` for a typed
name versus an alias; (d) that the hook runs with the session's environment (our mark path variable); (e) the
time from the submit key to the hook's run. If (a) fails there is no reason to continue: the change is withdrawn
and the finding goes to the phone's author. The numbers go to `docs/lessons/transcript.md`, and a CLI upgrade
re-runs them.

### D2. One mechanism: the reply itself decides whether to arm

`sendReply` already holds the cleaned text and writes the submit key last. It gains one step beside `armOrigin`:
if the text **as it will be written** (`full`, which carries an attachment sentence when the reply has attachments) is exactly `/model <name>` — one argument, `name` matching the charset of D4 — it arms
`name` for the session, after every re-check and immediately before the key (so a withheld key, i.e.
`filled-not-submitted`, arms nothing, and a failure to arm is no arming, never a failed reply). `conversation.setModel` is then a validated `conversation.send`
of `/model <name>`; it adds no second path. Consequence, **decided**: a hand-typed `/model sonnet` through
`conversation.send` arms too. The alternative (arm only through `setModel`) leaves an older phone able to open
the invisible box and lose its next reply, which is the very failure this change exists to remove, and the user
who types it has asked for exactly that switch.

A bare `/model` (the picker), `/model` with more than one argument, a multi-line or attachment-carrying text (the CLI would receive more than the name) and any other text arm nothing.

### D3. The hook command: allow only the armed command switch

Injected through the existing `hooks` field of the injection contribution (event `PreModelSwitch`), with the
mark path in a new pty environment variable `SPEKTERM_MODEL_FILE`. The mark file holds `<deadline-seconds>
<name>`. The command reads stdin (`cat`, as the origin command does) into a variable with spaces and newlines
removed (so the match does not depend on the CLI's JSON spacing), takes the mark with `mv` to `<file>.$$`, reads
it, and:

- prints the `allow` JSON only when the deadline has not passed **and** the stdin contains `"source":"command"`
  **and** `"requested_model":"<name>"` (a quoted `case` pattern; D4's charset makes the name safe to compare and
  `[`/`]` literal when quoted);
- **after an allow, puts the mark back with its deadline cut to 5 seconds from now** (D5a); removes it only when
  its deadline has passed; when the switch did not match, puts it back unchanged — so a switch the user made at
  the desktop in that window neither consumes the phone's mark nor is let through. Putting back is `ln` (fails if a
  newer mark exists) then `rm` of the taken file, not a check followed by `mv`: a re-arm in between is never
  overwritten;
- always exits 0 and prints nothing otherwise (a `PreModelSwitch` hook that errors or times out is treated as
  blocking: the switch would be cancelled, so the command must be quiet and fast).

The substring match depends on the CLI's JSON spacing (D1c). If the spacing is not stable the command extracts
the two fields with `sed`; it does not need `jq`, which the user may not have.

### D3a. Measured (CLI 2.1.310, task 1.1)

`requested_model` is the typed name **lower-cased** (`/model Sonnet` → `sonnet`; `opus[1m]` kept), so the mark and
the comparison are lower-case (the name is lower-cased when armed and stdin's value is compared as is). The hook
runs once for `sonnet` and `opus[1m]`, **twice for `opusplan` and `haiku`** (two (from, to) pairs, D5a), and not at
all when the target equals the current model (the mark then lapses unused). Allow skipped the box when idle and
while the agent worked. The stdin JSON is compact; the session's environment reaches the hook.

### D4. Model name charset and bound

`model` is 1–100 characters from `[A-Za-z0-9._:/@\[\]-]` (covers `sonnet`, `claude-opus-5-5`, `opus[1m]`, dated
ids, Bedrock ids and ARNs, Vertex ids such as `claude-sonnet-4@20250514`). Anything else — whitespace, quotes, control characters, a leading `-`, empty — is
`BAD_PARAMS`. It is narrower than the phone's "no whitespace" contract on purpose, and the protocol document says a client must expect `BAD_PARAMS` for a name outside it: the name is compared in a shell pattern and typed
into a command line, and a name with other characters is not one the phone's list offers. The name is never
interpolated into the hook command; it is read from the mark file.

### D5. TTL

The mark expires 15 s after it is armed (the CLI runs the hook as it processes the submitted command, which is
immediate; the margin covers a loaded machine; `ORIGIN_TTL_S` is 10). A mark nobody takes — the key did not take, the agent shows a
different box — lapses, so it cannot permit a later switch the user starts at the desktop. A new mark replaces
an older one (last write wins), and closing or ending a session clears it, as `clearOrigin` does.

### D5a. One switch can ask the hook more than once

Read from the 2.1.310 binary (the reviewer's reading, to be measured in 1.1): the CLI asks the hook once per
(from, to) pair its switch computes — one for the current permission mode and one for the plan/default
counterpart, which differ for models such as `opusplan` — and skips the box only if **every** answer allows; it
asks again, round by round, when the session's model changes while a hook runs. A mark consumed by the first
answer would leave the second silent and the box would open, the very failure this change removes. Hence an
allow does not delete the mark: it shortens its deadline to 5 s, and a request for the same name inside that
window is allowed too. "One switch" is therefore "one armed request", which may be asked about several times.

### D6. What the answer means

`outcome: "submitted"` means the key was written, as for `send`. It does **not** mean the model changed. The
client confirms with `conversation.status` (model) or the conversation entry for `r.text`, and after a few
seconds without either tells the user to look at the desktop. The desktop does not try to detect the box.

### D7. Errors

Inherited from `conversation.send`: `NOT_WATCHING`, `WAIT_STATE`, `PREFILL_PENDING`, `NOT_FOUND`, `NO_CONVERSATION`;
plus `BAD_PARAMS` for a `model` outside D4. A session whose agent events are off already answers `WAIT_STATE`.

### D8. The protocol document

`conversation.send`'s "one sent while the agent works runs after its turn" is true of skills and false of the
built-in `/model` and `/effort` (run at once, measured on 2.1.310). The line is corrected in this change, and a
new client obligation says: never send a bare `/model` or a bare `/effort` (each opens an interactive picker the phone
cannot see; bare `/effort` measured on 2.1.310 by the phone's author), and expect `BAD_PARAMS` for a name outside D4.
The arming compares the whole name with the CLI's `requested_model`; whether the CLI normalizes that field (an alias,
case) is measured in 1.1, and if it does, the comparison follows the measurement and this paragraph says so.

## Risks / Trade-offs

- Hook behavior unmeasured → D1 gates the work; if allow does not skip the box, the change is withdrawn and the phone's author (session `spekterm-android-acaf`) is told. A CLI upgrade could change the stdin shape or the decision
  contract; the lesson's measurement is re-run on upgrade, like the key plans.
- A switch the user starts at the desktop within 15 s of a phone's `/model x` for the **same** name would also be
  let through (source `command`, same name). Accepted: the user asked for that exact switch twice.
- If the hook does not run (agent events off, a session started by an older build) the box opens as today and the
  client's timeout is the only signal (D6). Not detectable from here.
- `allow` skips a protection whose purpose is the user's cost (the cache is lost). The user's own tap on the
  phone is the confirmation; the phone says so before sending.
