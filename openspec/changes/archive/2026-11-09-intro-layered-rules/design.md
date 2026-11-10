## Context

See proposal.md for why. The current state, measured by importing `src/main/handoff-intro.ts` (review round 1, zone
Asia/Taipei):

| Section | Characters | Who gets it |
|---|---|---|
| Opening and delivery rules (outbox, atomic write, shape, limits, `at`, `repeat`) | ~2,100, of which the four `repeat` lines 673 | every session |
| Target rule and repo list (30 folders) | ~1,200 | every session |
| Receipts and the schedules-file sentence | 1,317 | every session |
| Name and relations | 1,529 | every claude session |
| Session commands | 1,286 | every session |
| Completion report | ~700 | sessions created by a handoff |
| Teammates | ~250 | sessions on a team |

The longest variant (30 folders, created by a handoff, on a team) measures 8,474 characters and 108 lines against a
budget of 8,500 and a run-time hard limit of 9,000 (`INTRO_HARD_LIMIT`, past which the repo list is cut). Its length
depends on the host's zone name, because the budget test passes no `timeZone`. The CLI threshold was last measured
with Claude Code 2.1.317 in `-p` mode (`docs/lessons/handoff.md` §16): 10,000 characters arrive whole, 10,001 are
replaced by a 2 KB preview. The CLI binary also carries an 8,000-character / 200-line cut that did not apply in
either measurement. The installed CLI is now 2.1.319.

Two files already follow the layered pattern: the teammates file (`teammates-file.ts`) and the schedules file
(`schedules-file.ts`). Each is a JSON object with a `rules` string, written whole under `<userData>/handoff/`; the
introduction carries one or two sentences that send the agent there before the only action the rules constrain, and
the spec counts those rules as stated. `scripts/handoff-intro-source.test.mjs` forbids literal limits in the
introduction and the teammates file.

Main-spec text that assumes a rule is in the introduction, and changes with this one: `session-hibernation`
("Agents are told what a listed session without a process is"), and `build-identity` ("每一份產物的版本由打包指令自身遞增",
which a release check before the bump qualifies). `recurring-handoff` ("A recurrence is not a promise that work runs
while spekterm is closed") stays true because the introduction keeps that clause (D1).

## Goals / Non-Goals

**Goals:**

- The longest introduction drops to about 6,500 characters and 94 lines (measured after implementation, zone
  America/Argentina/Buenos_Aires), and a new capability adds one or two
  sentences, not a paragraph.
- The introduction stays under both of the CLI's known cuts, including the 8,000-character / 200-line one that does
  not apply today, so a CLI update that turns that cut on loses nothing.
- A change in the CLI's threshold is found by a measurement that release requires, not by memory.
- No behavior an agent relies on changes: every rule still reaches the agent before the action it constrains.

**Non-Goals:**

- Varying the introduction further by session. What can vary already does (teammates, report, relations), and the
  budget is measured on the variant that has every section.
- Delivery through an MCP tool.
- Shortening the receipts paragraph or the delivery rules for a repo handoff. A repo handoff is the most common
  action and the first thing any agent may do; its rules stay in the introduction.
- Measuring in interactive mode by script. It needs a real pty; in 2.1.303 it matched `-p` at every size.

## Decisions

### D1. What stays and what moves: "needed before the first action" vs "needed before one rarer action"

A rule stays in the introduction when the agent may need it before any action it takes: the repo handoff (outbox,
atomic write, shape, limits, `at`, target matching, the repo list), receipts (every action produces one), its own
name, where its relations are, and that a message may go unanswered. A rule moves when it constrains only one
action that is rarer than a repo handoff, and that action can be gated by "read this file first":

| Moves | To | Stays in the introduction |
|---|---|---|
| Cron syntax, what is refused, the rules for `until`, approval details, missed times | repeating rules file | the `repeat` field and its end `until`, the desktop's zone by name, that the user approves it first, that it opens only while spekterm runs, the file's location |
| That a wake is carried out without asking, when close and hibernate take effect, what cancels them, the offered self-close, rename rules and limit, which sessions a target may name, that a running target needs agent event reporting, wake's follow-up (when the woken session can be messaged, not waking a parent only to report, not repeating a wake that did not take), what a command's receipt means | commands rules file | the four command shapes on one line, that a wake starts a dormant session, that no target means the agent's own session, the file's location |
| Meaning of `running`, `state`, `summary`, nesting, `parentGone`, and "a session handed off by another has a parent" | the relations file itself (`about`) | the file's location, that it lists relatives with their current names and whether they are running, that it is kept up to date, that messaging is Claude Code's `SendMessage` by name, that a message may go unanswered |

**`until` leaves the Shape line.** Today the Shape line lists `"until": "<optional>"`, and `until` without `repeat`
is refused (`REPEAT_INVALID`). An agent that does not mean to repeat would not read the repeating file, so that
refusal would be unstated. The Shape line lists `target`, `title`, `body`, `at` and `repeat`; the repeat sentence
names `until` as the repeat's end, and its rules are in the file.

**Missed times stay one clause in the introduction**: "it opens only while spekterm runs; times missed while it was
closed run once at the next start" is short, and `recurring-handoff` requires the introduction to say so (it is not
a refusal rule but an expectation about when work happens, which an agent may need before deciding to repeat at
all).

Estimated result (review round 1 simulated the cut): about 6,322 characters and 92 lines (zone Asia/Taipei); the
implementation measures 6,520 and 94 lines in the budget test's longer zone; repeat saves about 450,
commands about 1,000, relations about 700.

Alternative considered: one combined rules file. Rejected: the agent would read every rule to use one, and "read
this before a repeating handoff" would point to a file mostly about something else.

Alternative considered: keep each action's refusal constraints (the rename limit, the cron rejections) in the
introduction and move only the explanations. Rejected: those constraints are most of what moves, and the spec
already accepts a rule in a file the agent is sent to before the action (teammates, schedules). D4 makes that the
general rule.

### D2. Rules files: `<userData>/handoff/repeating.json` and `<userData>/handoff/commands.json`

Same form as the teammates and schedules files: a JSON object whose `rules` is one string of sentences, written
whole (temporary name, then rename), written only when the content on disk differs. They sit beside `teammates.json`
and `schedules.json` at the handoff root, **never inside an outbox**: an outbox is scanned for `.json` deliveries,
and a rules file there would be read as one. (`sourceSessionOf` requires two path levels under the outbox root, so a
file at the handoff root is never taken for a delivery.)

They are the same for every session (the zone in the repeating file is the desktop's, as in the introduction today),
so there is one of each, not one per session. They are written at startup when the handoff root is configured, and
at every intro write point (spawn and `refreshIntros`), so a changed zone or a changed constant reaches the file when
it reaches the introduction, and a deleted file comes back at the next write point. A write failure is swallowed, as
the other files do: the agent loses the file, and a delivery it writes anyway is still checked and its receipt names
the rule broken (D5).

The commands file states the target rule for a session with a relations file. The introduction's no-relations
wording (`commandLines(false)`) is dropped: every claude session that gets an introduction gets a relations file
(`handoff-injection.ts` passes `relationsFile(sessionId)` whenever the outbox exists; the global session included),
so that branch is unreachable in production.

New source modules hold literal strings near `MAX_REPEAT_SEARCH_YEARS` (a single digit): the source guard matches
substrings, so examples in the new files avoid that digit.

### D3. The relations file describes itself: an `about` string

`handoff-relations.ts` writes each session's relations file; it gains a top-level `about` string stating what each
field means. The agent has to read this file to use any relation, so the explanation is where it is used, and it is
current with the file's own shape. `about` contains no path and no session id (`session-lineage` forbids path
fields), and no third-party text. The `teammateHandoffs` field is already explained by the teammates file; `about`
names it in one clause and points to the teammates file by name, not by path. Existing files gain `about` at the next relations refresh (any session, pty
or folder change; the restore at startup triggers one, and the in-memory cache is empty after a restart), since
every file's content then differs and is rewritten. No consumer compares a relations file whole
(`relativeNamesOf` reads fields).

Alternative considered: a separate relations rules file. Rejected: one more file to point to, for rules that only
matter while reading this one.

### D4. "Stated" includes a rules file the introduction sends the agent to

The rule in `agent-handoff-source` — every constraint that refuses a delivery is stated, derived from the constants
the check uses — is restated: a constraint counts as stated when it is in the introduction, or in a file whose
location the introduction gives together with the instruction to read it before the only action it constrains. The
file's limits SHALL be derived from the constants, and `scripts/handoff-intro-source.test.mjs` extends to the two new
files (as it does to the teammates file).

The condition "the only action it constrains" is checked per rule: a rule that can refuse an action the agent did
not choose to take through the file (as `until` could, D1) stays in the introduction.

What this gives up: an agent that skips the file meets the rule only in a receipt, after the fact. D5 makes that
receipt point at the file; the dogfood task observes whether a real agent reads it first.

### D5. Refusal reasons name the rules file

The reason's text is chosen in `receiptFor`, which today calls `receiptReason(code)` and so can tell neither a
handoff's `TOO_LONG` from a rename's nor give a path. The outcome already carries `failure.subject` (`'command'` for
every refusal `session-control.ts` makes, `intake-service.ts`), so `receiptFor` chooses by code and subject, and
takes the file locations from `handoff-outbox.ts`:

| Refusal | Reason names |
|---|---|
| `REPEAT_INVALID` | the repeating rules file (replacing "see your introduction") |
| subject `command` with `CONTROL_NOT_ALLOWED`, `CONTROL_TARGET_NOT_FOUND`, `CONTROL_UNAVAILABLE`, `TOO_LONG` or `FIELD_TYPE` | the commands rules file |

`CONTROL_NO_WINDOW` and `CONTROL_FAILED` are not rule breaches and keep their reasons. `TOO_LONG` for a handoff or a
report keeps "the limits are in your introduction", which stays true. The path is system-written and already appears
in the introduction, so the receipt's "no delivery text" rule (`handoff-receipt`) is unaffected.

### D6. Limits: budget 7,000 characters, hard limit 7,900 characters and 190 lines, all inclusive

With the latent CLI cut at 8,000 characters / 200 lines, a hard limit above it is a bet that the cut stays off. Both
limits go below it:

- `INTRO_HARD_LIMIT` becomes 7,900 characters, and a new `INTRO_LINE_LIMIT` of 190 lines applies the same way: when
  either would be exceeded, the repo list is cut (never the rules) and says how many repos were left out. Both are
  inclusive (at most), as the character limit is today. The line limit matters for a large workspace: one repo is one
  line. Measured in review: with 200 folders the character limit binds first (about 115 repos, about 178 lines); with
  300 three-character names the line limit binds first.
- `INTRO_BUDGET` (7,000) moves from the test into `handoff-intro.ts` as an export, so the threshold test and the
  measurement script can read it from source. The budget test (30 folders, longest variant) asserts at most 7,000
  characters and at most 190 lines, and passes a fixed long zone name (`America/Argentina/Buenos_Aires`) so its
  length does not depend on the host.

Cost: a workspace large enough to hit the hard limit lists fewer repos than at 9,000. After the saving it still lists
about as many as before this change.

### D7. The threshold measurement: a script, a record, a test, a release check

- **Script** (`scripts/measure-intro-threshold.mjs`, `npm run measure:intro`): for each case, writes a
  `hookSpecificOutput` JSON whose `additionalContext` is filler of exactly that shape ending in a random marker,
  points a temporary `--settings` file's `SessionStart` hook at it (`cat`, as spekterm does), and runs
  `claude -p --model haiku --tools "" --no-session-persistence` in an empty temporary directory, asking for the
  marker. No tools, so the agent cannot read the saved file behind a preview and report the marker anyway; no
  session persistence, so no transcript lands in `~/.claude/projects`, which the app's conversation insights scan.
  The nested-session variables are stripped from the child's environment (`docs/lessons/handoff.md` §11).
  Marker in the reply: whole. Missing: replaced.
- **Markers**: each case carries a random marker at its very start and another at its very end, and is asked up to
  three times, because Haiku sometimes answers NONE with both markers in its context (2 of 5 runs, measured while
  implementing). An end marker in any reply: whole (it is random, so it cannot be guessed). A start marker in some
  reply and no end marker in any: cut (the CLI's preview keeps the first ~2,000 characters, and its latent cut keeps the start too — it
  takes the first 200 lines, then the first 8,000 code units, review round 2 read in the 2.1.319 binary). Neither
  present, or a non-zero exit: the run fails, because an API, rate-limit or network failure is not a cut and could
  otherwise hide the negative control.
- **Cases**, each recorded as `{ chars, lines, whole }`, the limits read from `handoff-intro.ts` source as the source
  guard reads constants:
  - positive control: 200 characters, 1 line — must arrive whole, or the hook did not fire and the run fails;
  - the budget, the hard limit (characters, few lines), and the line limit (190 short lines, few characters);
  - the latent cut's far side: 8,001 characters (few lines) and 201 short lines;
  - 10,000 characters, and 10,001 characters as the negative control — must come back replaced;
  - informational, recorded under a separate `informational` key and excluded from the test: two hooks of 6,000
    characters each in one session, to learn whether the threshold is per hook or summed (not known,
    `docs/lessons/handoff.md` does not say).
  A run whose positive control is replaced, or whose negative control arrives whole, fails without writing the
  record. **When the negative control arrives whole the threshold has moved**: the script says so and that its
  sizes must be extended to find the new one; the release stays refused until a record from the updated script is
  committed. That is deliberate: a moved threshold is what the check exists to surface.
  The CLI path and the record path can be overridden (arguments), so a unit test drives the script with a stub CLI
  and asserts its argv (`--tools ""`, `--no-session-persistence`).
  The maintainer's user settings are loaded by the run, as they are in real sessions.
- **Record** (`scripts/intro-threshold.json`): CLI version, date, mode, model, and each case's result. Written by the
  script, reviewed and committed by the maintainer.
- **Test** (`scripts/intro-threshold.test.mjs`, in `npm test`): the record holds the budget, the hard limit and the
  line limit cases (a record without them fails), and every recorded case with at most the hard limit's characters
  and at most the line limit's lines is whole. A case beyond either limit may be cut, so the latent cut turning on
  (201 lines cut) keeps the test green, as D6 intends, and a threshold that fell to or below a limit cuts the hard
  limit or line limit case and turns it red. (The latent cut is an OR of a character and a line condition, each
  counted as `introText` counts them, so measuring the two axes separately matches it; the corner of 7,900
  characters on 190 lines needs no case of its own.)
- **Release check** (`scripts/intro-threshold-check.mjs`, the first step of `dist:linux`, before `release-bump.mjs`
  so a refusal leaves no commit): parses the semver at the start of `claude --version` (its output is
  `<version> (Claude Code)` followed by more) and refuses when it differs from the record's version, when `claude`
  is not found, or when the record has uncommitted changes (a record measured but not committed would also mark the
  build dirty), with the versions and the command to run. No override: the check is the guard. A static
  assertion in `scripts/packaging-config.test.mjs` holds the order in `dist:linux`.
  `probe:package` enters through `dist:linux`, so it inherits the check; iteration already goes through
  `PROBE_PACKAGE_APPIMAGE`, which skips packaging.

Alternative considered: compare only the minor version. Rejected: the threshold is CLI behavior and any release can
change it; a measurement is a minute and a few cents.

Alternative considered: measure at run time in the app. Rejected: it would spend the user's money and add network
calls to the app (`scripts/network-surface.test.mjs`) to protect against something the release can check.

## Risks / Trade-offs

- [An agent writes a repeating handoff or a command without reading the rules file] → It is refused with a receipt
  that names the file (D5), and the next attempt follows it. The cost is one refused attempt, which the "stated"
  rule exists to avoid; the dogfood task measures whether it happens.
- [A user runs a CLI other than the one measured] → The release proves the threshold for the maintainer's CLI only.
  Staying under the latent 8,000 / 200 cut (D6) leaves 2,100 characters of margin below the measured threshold, so
  only a CLI that lowers the threshold below 7,900 would hurt, and the next release's measurement would show it.
- [A CLI update every few days makes the release check run often] → Accepted: one minute and a few cents per release.
  The maintainer's release procedure runs the measurement and commits the record itself when the check refuses, and
  stops for the maintainer only when the measurement fails or the test turns red, so the check costs attention only
  when the threshold actually moved. A warning instead of a refusal was rejected: it would be one line in a long
  build log that nobody reads.
- [The threshold is summed across hooks, and the user's own hooks add context] → Unknown today; the informational
  case records it. If it is summed, the margin to the user's hooks is the user's, and `docs/lessons/handoff.md` says so.
- [Running sessions keep their old, longer introduction until their context is rebuilt] → Accepted: both
  introductions describe the same behavior; only the receipts' wording changes at once.
- [The measurement prompt itself changes what the agent reports] → The marker is random per case and checked
  verbatim, tools are off, and both controls must hold or nothing is recorded.

## Migration Plan

No data migration. On the first start of the new version the two rules files are written and every live session's
relations file is rewritten with `about` at the first relations refresh; introductions are rewritten at the next
intro write point. Rollback: the previous version ignores the extra files and the extra `about` field.
