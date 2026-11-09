## Why

The introduction every agent session receives (issue #104) is at 8,474 (zone Asia/Taipei) of its 8,500-character budget, and the
budget sits under a CLI threshold (10,000 characters) past which the agent keeps only a 2 KB preview and loses every
rule after it, silently. Every capability that talks to the agent has added a paragraph, the next one does not fit,
and the threshold itself is a remembered measurement that a CLI update can move without anything turning red.

## What Changes

- **Layered rules.** The introduction keeps what every agent needs on every turn — that it runs in spekterm, how to
  hand off to a repo (outbox, atomic write, shape, the limits that refuse a handoff, `at`), the repo list, receipts,
  its name — and, for each action used less often, one or two sentences saying the action exists plus the location
  of a file to read before taking it. This is the pattern the teammates and schedules files already use.
  - **Repeating handoffs**: the cron syntax, what is refused and the rules for `until` move to a new
    **repeating rules file**. The introduction keeps the `repeat` field and its end `until`, the desktop's time
    zone, that the user approves it first, that missed times run once at the next start, and the file's location.
    `until` leaves the general shape of a handoff, since its refusal would otherwise be unstated for an agent that
    does not mean to repeat.
  - **Session commands**: when they take effect, what cancels them, the offered self-close, the rename limit, the
    wake's follow-up (when a woken session can be messaged, not waking a parent only to report), and what a receipt
    means for a command move to a new **commands rules file**. The
    introduction keeps the four command shapes, that no target means the agent's own session, and the file's
    location.
  - **Relations file fields** (running, state, nesting, a lost parent) move **into the relations file itself**, which the agent must read anyway to
    use any of it. The introduction keeps its location, that it is kept up to date, and that messaging goes through
    Claude Code by name.
- **Refusal reasons point to the rules.** A receipt that refuses a repeating handoff or a session command names the
  file whose rules it broke, instead of "see your introduction".
- **The threshold is measured by a script and checked at release.** A script measures, with the installed Claude
  Code, which injected sizes reach the agent whole, and records the result with the CLI version in the repo. A unit
  test holds the introduction's limits below the recorded threshold, and `dist:linux` refuses to release when the
  installed CLI differs from the one recorded.
- **Limits drop below the CLI's latent cut.** The budget becomes 7,000 characters, the hard limit 7,900 characters
  and a new 190 lines, all below the 8,000-character / 200-line cut the CLI carries but does not apply today.
- The rule "every constraint that refuses a delivery is stated" is restated so that a rule in a file the
  introduction directs the agent to read before the only action it constrains counts as stated (already true for
  the teammates and schedules files; now the general rule).
- Not in this change: varying the introduction further by session (most of what can vary already does, and the
  budget is measured on the variant that has every section), and delivery through an MCP tool (stays on the
  roadmap).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-handoff-source`: the introduction's content requirement (repeat paragraph becomes a pointer; the general
  "stated" rule covers rules files), the session-commands requirement (most of it moves to the commands rules file),
  and a new requirement for the measured threshold, its record, and the release check.
- `session-lineage`: the relations file describes its own fields.
- `handoff-receipt`: a refusal of a repeating handoff or a session command names the rules file it broke.
- `session-hibernation`: what a not-running relative means is stated by the relations file, not the introduction.
- `build-identity`: a release precondition that refuses before the bump (the CLI version check) is not a manual
  bump step.

## Impact

- `src/main/handoff-intro.ts` (shorter repeat, commands and relations paragraphs), new rules-file writers beside
  `teammates-file.ts` / `schedules-file.ts`, `src/main/handoff-relations.ts` (an `about` field),
  `src/main/agent-protocol-copy.ts` (receipt reasons), `src/main/handoff-injection.ts` / `handoff-outbox.ts` (file
  locations, written at the intro write points).
- New `scripts/measure-intro-threshold.mjs` and its record file; a release check step in `dist:linux`; unit tests
  for the budget against the record.
- `scripts/handoff-intro-source.test.mjs` extends its "no literal limits" guard to the new rules files.
- Tests: `handoff-intro.test.ts` assertions move to the rules files' tests; `probe:intake` handoff sections if they
  assert moved text; `scripts/scenario-coverage.test.mjs`.
- Docs: `docs/lessons/handoff.md` §16 (how to re-measure), CLAUDE.md's introduction note, the website's handoff
  pages if they describe the introduction's content.
- No new dependencies. The measurement script calls the real `claude` CLI (network, a few cents); it is never part
  of `npm test` or `test:e2e`.
