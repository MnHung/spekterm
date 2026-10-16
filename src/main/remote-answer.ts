import type { FinishedCall, OpenRequest, Question } from './agent-events'
import { RemoteError } from './remote-frames'

/**
 * A paired device answers the agent's open prompt (`remote-protocol`, D3 / D5 of
 * `remote-prompts-attachments-rename`).
 *
 * ## An answer is the keys a user would press, never text
 *
 * Text and Enter typed into an open prompt approve it (`companion-test-fixes`). So an answer is a short plan of
 * keys, **never including Enter**, written one at a time. The plans rest on measurements of the real agent
 * (CLI 2.1.300, `docs/lessons/transcript.md`; re-measure after a CLI upgrade):
 *
 * - a permission prompt of `Bash`, `Edit`, `Write`, `Read` or `WebFetch` puts a one-time "Yes" first, and `1`
 *   picks it without Enter. Other tools were not measured, so they cannot be allowed from a device;
 * - Esc dismisses any prompt: the agent's own turn ends, and the agent stays in plan mode on a plan approval;
 * - a question's option digits pick a single-choice option and move on, or toggle a several-choice option.
 *   Tab leaves a several-choice question. With more than one question, or a several-choice one, a review
 *   follows, and `1` submits it. **Enter toggles the option under the cursor**, one more reason it is never sent;
 * - the plan approval with a plan reads `1. Yes, and use auto mode` / `2. Yes, manually approve edits`;
 *   without a plan, `1. Yes, and switch to default`;
 * - every key in one write answered wrongly; 100 ms and 250 ms gaps both answered right.
 *
 * ## Before every key, five checks
 *
 * The open requests are read again (`refreshWait`), and the key is written only if:
 * 1. exactly one request is open (queued prompts: only the first is on screen);
 * 2. it is the one answered;
 * 3. nothing was typed into the session since its tool call started (the desktop answered, dismissed or
 *    half-answered it: none of that reports an event before the tool ends, or at all);
 * 4. its agent reported no other tool start or finish since then (`OpenRequest.stirred`);
 * 5. no earlier answer was written to it (an allowed tool runs for minutes before it closes).
 *
 * The agent waits for its tool-start hook before it shows a prompt, so a prompt that replaced the answered one
 * is known before the next key.
 */

/** Tools whose permission prompt was measured to put a one-time approval first. */
export const ALLOW_ONCE_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Edit', 'Write', 'Read', 'WebFetch'])

export const KEY_GAP_MS = 250
export const CONFIRM_MS = 3000

const ESC = '\x1b'
const TAB = '\t'

export type AnswerDecision = 'allow' | 'deny' | 'answer' | 'approve' | 'approve-auto'
export const DECISIONS: readonly AnswerDecision[] = ['allow', 'deny', 'answer', 'approve', 'approve-auto']

export type AnswerOutcome = 'sent' | 'partial' | 'confirmed' | 'mismatch'

export type PromptView =
  | { id: string; kind: 'permission'; tool: string; arg: string | null; canAllow: boolean; answerable: boolean; open: number }
  | { id: string; kind: 'question'; questions: Question[]; answerable: boolean; open: number }
  | { id: string; kind: 'plan'; plan: string | null; choices: AnswerDecision[]; answerable: boolean; open: number }

type Kind = PromptView['kind']

export function kindOf(request: OpenRequest): Kind {
  if (request.tool === 'AskUserQuestion') return 'question'
  if (request.tool === 'ExitPlanMode') return 'plan'
  return 'permission'
}

/** 1 to 4 questions, each with 1 to 8 options: digits then always name listed options. */
export function questionsAnswerable(questions: Question[] | null): questions is Question[] {
  if (!questions || questions.length < 1 || questions.length > 4) return false
  return questions.every((question) => question.options.length >= 1 && question.options.length <= 8)
}

/** Checks 1, 3, 4 and 5 for the first open request (check 2 is the caller's id). */
function clear(requests: OpenRequest[], lastKeystroke: number | null): boolean {
  if (requests.length !== 1) return false
  const request = requests[0]
  if (lastKeystroke !== null && lastKeystroke > request.at) return false
  return !request.stirred && request.answeredAt === null
}

/** What a device is told about the open prompt (`conversation.wait`'s `prompt`), or `null`. */
export function promptView(requests: OpenRequest[], lastKeystroke: number | null): PromptView | null {
  const request = requests[0]
  if (!request) return null
  const ok = clear(requests, lastKeystroke)
  const open = requests.length
  switch (kindOf(request)) {
    case 'question':
      return { id: request.id, kind: 'question', questions: request.questions ?? [], answerable: ok && questionsAnswerable(request.questions), open }
    case 'plan':
      return {
        id: request.id,
        kind: 'plan',
        plan: request.plan,
        choices: request.plan === null ? ['approve', 'deny'] : ['approve', 'approve-auto', 'deny'],
        answerable: ok,
        open,
      }
    default:
      return {
        id: request.id,
        kind: 'permission',
        tool: request.tool,
        arg: request.arg,
        canAllow: ALLOW_ONCE_TOOLS.has(request.tool),
        answerable: ok,
        open,
      }
  }
}

export interface KeyPlan {
  keys: string[]
  /** What the agent records when the answer took: the question's answers, or the plan's permission mode. */
  expect?: { answers: Record<string, string> } | { mode: string }
}

function notAnswerable(message: string): RemoteError {
  return new RemoteError('NOT_ANSWERABLE', message)
}

function selectionsFor(questions: Question[], raw: unknown): number[][] {
  if (!Array.isArray(raw) || raw.length !== questions.length) {
    throw new RemoteError('BAD_PARAMS', '`selections` must hold one entry per question')
  }
  return questions.map((question, index) => {
    const entry = raw[index]
    if (!Array.isArray(entry) || entry.length === 0) throw new RemoteError('BAD_PARAMS', `question ${index + 1} needs a choice`)
    const chosen = entry.map((value) => {
      if (!Number.isInteger(value) || value < 0 || value >= question.options.length) {
        throw new RemoteError('BAD_PARAMS', `question ${index + 1} has no option ${String(value)}`)
      }
      return value as number
    })
    if (new Set(chosen).size !== chosen.length) throw new RemoteError('BAD_PARAMS', `question ${index + 1} names an option twice`)
    if (!question.multiSelect && chosen.length !== 1) throw new RemoteError('BAD_PARAMS', `question ${index + 1} takes one choice`)
    return [...chosen].sort((a, b) => a - b)
  })
}

/** The keys for a decision on a request, or a refusal. Pure. */
export function planKeys(request: OpenRequest, decision: AnswerDecision, selections?: unknown): KeyPlan {
  const kind = kindOf(request)
  if (decision === 'deny') return { keys: [ESC] }
  if (kind === 'permission') {
    if (decision !== 'allow') throw notAnswerable(`\`${decision}\` does not answer a permission prompt`)
    if (!ALLOW_ONCE_TOOLS.has(request.tool)) throw notAnswerable(`${request.tool} cannot be allowed from a device`)
    return { keys: ['1'] }
  }
  if (kind === 'plan') {
    if (decision === 'approve') return { keys: [request.plan === null ? '1' : '2'], expect: { mode: 'default' } }
    if (decision === 'approve-auto') {
      if (request.plan === null) throw notAnswerable('approving with auto mode needs a plan')
      return { keys: ['1'], expect: { mode: 'auto' } }
    }
    throw notAnswerable(`\`${decision}\` does not answer a plan approval`)
  }
  if (decision !== 'answer') throw notAnswerable(`\`${decision}\` does not answer a question`)
  const questions = request.questions
  if (!questionsAnswerable(questions)) throw notAnswerable('this question cannot be answered from a device')
  const chosen = selectionsFor(questions, selections)
  const keys: string[] = []
  const answers: Record<string, string> = {}
  questions.forEach((question, index) => {
    for (const option of chosen[index]) keys.push(String(option + 1))
    if (question.multiSelect) keys.push(TAB)
    answers[question.question] = chosen[index].map((option) => question.options[option].label).join(', ')
  })
  // One single-choice question submits on its digit; anything else ends on the review.
  if (!(questions.length === 1 && !questions[0].multiSelect)) keys.push('1')
  return { keys, expect: { answers } }
}

export interface AnswerDeps {
  /** Reads the session's events now and returns its open requests (`refreshWait` + `openRequestsOf`). */
  refresh(sessionId: string): OpenRequest[]
  lastKeystrokeAt(sessionId: string): number | null
  /** Writes one key as an answer's own (`origin: 'answer'`); `false` when the session has no pty. */
  write(sessionId: string, key: string): boolean
  markAnswered(sessionId: string, requestId: string, at: number): void
  dismiss(sessionId: string, requestId: string): void
  /** Resolves with the call's end when it arrives within `ms`, else `null`. */
  awaitFinished(sessionId: string, toolUseId: string, ms: number): Promise<FinishedCall | null>
  delay(ms: number): Promise<void>
  now(): number
}

function matches(expect: NonNullable<KeyPlan['expect']>, finished: FinishedCall): boolean {
  if ('mode' in expect) return finished.permissionMode === expect.mode
  if (!finished.answers) return false
  return Object.entries(expect.answers).every(([question, labels]) => finished.answers?.[question] === labels)
}

/**
 * Writes a device's answer. Call it inside the session's queue (`runQueued`). Throws `PROMPT_GONE` when the
 * first key is withheld, and the refusals of `planKeys`.
 */
export async function writeAnswer(
  deps: AnswerDeps,
  sessionId: string,
  promptId: string,
  decision: AnswerDecision,
  selections?: unknown,
): Promise<AnswerOutcome> {
  const first = deps.refresh(sessionId)
  const request = first.find((candidate) => candidate.id === promptId)
  if (!request) throw new RemoteError('PROMPT_GONE', 'that prompt is no longer open', { open: first.length })
  const plan = planKeys(request, decision, selections)

  for (let index = 0; index < plan.keys.length; index += 1) {
    const requests = index === 0 ? first : deps.refresh(sessionId)
    const current = requests[0]
    const ours = index > 0 && current?.id === promptId
    const ok =
      current?.id === promptId &&
      requests.length === 1 &&
      !current.stirred &&
      !((deps.lastKeystrokeAt(sessionId) ?? -Infinity) > current.at) &&
      (current.answeredAt === null || ours)
    if (!ok) {
      if (index === 0) throw new RemoteError('PROMPT_GONE', 'that prompt cannot be answered from a device now', { open: requests.length })
      return 'partial'
    }
    if (index === 0) deps.markAnswered(sessionId, promptId, deps.now())
    if (!deps.write(sessionId, plan.keys[index])) {
      if (index === 0) throw new RemoteError('NOT_FOUND', 'the session has no running process')
      return 'partial'
    }
    if (index < plan.keys.length - 1) await deps.delay(KEY_GAP_MS)
  }

  if (decision === 'deny') deps.dismiss(sessionId, promptId)
  if (!plan.expect || request.toolUseId === null) return 'sent'
  const finished = await deps.awaitFinished(sessionId, request.toolUseId, CONFIRM_MS)
  if (!finished) return 'sent'
  return matches(plan.expect, finished) ? 'confirmed' : 'mismatch'
}
