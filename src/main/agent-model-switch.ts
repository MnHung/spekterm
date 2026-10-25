import fs from 'node:fs'
import path from 'node:path'

import type { InjectionContribution } from './agent-injection'

/**
 * Letting a device's model switch past the agent's cache-miss confirmation (`remote-model-switch`).
 *
 * ## Why
 *
 * `/model <name>` on a conversation with a warm prompt cache opens a confirmation box in the agent's terminal. It
 * is no hook event, so a device cannot see it, and while it is open the next submit key answers its "Yes". The
 * agent's `PreModelSwitch` hook can answer `allow`, which skips the box (measured on CLI 2.1.310,
 * `docs/lessons/transcript.md`, "Model switch from a device").
 *
 * ## How
 *
 * The desktop **arms a mark** in a file of the session just before it writes the submit key of a one-name
 * `/model` reply. The injected hook command reads it and allows only a **command** switch whose requested name is
 * the armed one, before the deadline. In every other case it prints nothing, so a switch the user starts at the
 * desktop still asks.
 *
 * - **An allow does not consume the mark; it cuts its deadline to `MODEL_GRACE_S`.** The agent asks the hook once
 *   per (from, to) pair a switch computes — twice for `opusplan` or `haiku` (measured) — and skips the box only if
 *   every answer allows. The runs may also overlap, which is why the command never takes the file away.
 * - **The name is compared lower-cased**: the agent reports the typed name lower-cased (`Sonnet` → `sonnet`).
 * - **It always exits 0 and prints nothing without a match.** A hook that fails or times out blocks the switch.
 * - The name is read from the mark file, never put into the command line; the stdin JSON is compared with its
 *   spaces and newlines removed, so the match does not depend on the agent's spacing.
 */

/** How long an armed mark waits for the hook. */
export const MODEL_TTL_S = 15
/** How long a mark outlives the first allow (later runs of the same switch). */
export const MODEL_GRACE_S = 5

/** The pty environment variable naming a session's mark. */
export const MODEL_FILE_ENV = 'SPEKTERM_MODEL_FILE'

let modelRoot: string | null = null

export function configureAgentModelSwitch(userDataPath: string): void {
  modelRoot = path.join(userDataPath, 'agent-model')
}

function markPath(sessionId: string): string | null {
  return modelRoot ? path.join(modelRoot, sessionId) : null
}

const NAME_PATTERN = /^[A-Za-z0-9._:/@[\]][A-Za-z0-9._:/@[\]-]{0,99}$/

/** A model name a device may ask for: 1–100 characters, no whitespace, quotes or controls, not starting with `-`. */
export function isModelName(value: unknown): value is string {
  return typeof value === 'string' && NAME_PATTERN.test(value)
}

/** The name when `text` is exactly `/model <name>` (one argument); `null` for a bare `/model`, more arguments, other text. */
export function modelCommandName(text: string): string | null {
  const match = /^\/model ([^\s]+)$/.exec(text)
  return match && isModelName(match[1]) ? match[1] : null
}

const ALLOW_JSON = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'allow' },
})

/**
 * The hook command. **No `;` after `then`** — split across `; `-joined elements it is a syntax error that fails on
 * every run, silently (`docs/lessons/transcript.md`).
 */
export const MODEL_COMMAND =
  `in=$(cat 2>/dev/null | tr -d ' \\n'); f="$${MODEL_FILE_ENV}"; d=0; m=; ` +
  'if [ -n "$f" ] && [ -r "$f" ]; then { read -r d; read -r m; } < "$f" 2>/dev/null; fi; ' +
  'n=$(date +%s); ' +
  'if [ -n "$m" ] && [ "${d:-0}" -ge "$n" ] 2>/dev/null; then ' +
  `case "$in" in *'"source":"command"'*) case "$in" in *"\\"requested_model\\":\\"$m\\""*) ` +
  `printf %s '${ALLOW_JSON}'; nd=$((n+${MODEL_GRACE_S})); ` +
  'if [ "$nd" -lt "$d" ]; then printf \'%s\\n%s\\n\' "$nd" "$m" > "$f.$$" && mv "$f.$$" "$f"; fi;; esac;; esac; ' +
  'fi; exit 0'

/** The contribution for one agent session; `null` = not taking part (agent events off, or not configured). */
export function prepareModelSwitchInjection(sessionId: string, enabled: boolean): InjectionContribution | null {
  if (!enabled || !modelRoot) return null
  const target = markPath(sessionId)
  if (!target) return null
  try {
    fs.mkdirSync(modelRoot, { recursive: true })
    // A mark left by an earlier process of this session must not permit the new one's first switch.
    clearModelSwitch(sessionId)
  } catch {
    return null
  }
  return { settings: {}, hooks: { PreModelSwitch: [MODEL_COMMAND] }, env: { [MODEL_FILE_ENV]: target } }
}

/**
 * Arms the session's mark for `name`: the next command switch to it within `MODEL_TTL_S` is allowed. Call it
 * immediately before a device's submit key. `false` when it could not be written — then the box simply opens.
 */
export function armModelSwitch(sessionId: string, name: string, now: number = Date.now()): boolean {
  const target = markPath(sessionId)
  if (!target || !isModelName(name)) return false
  const temporary = `${target}.arming`
  try {
    fs.writeFileSync(temporary, `${Math.floor(now / 1000) + MODEL_TTL_S}\n${name.toLowerCase()}\n`, 'utf8')
    fs.renameSync(temporary, target)
    return true
  } catch {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // The next arm or the session's end tries again.
    }
    return false
  }
}

/** Removes the session's mark and whatever a hook run left beside it (`<id>.<pid>`, `<id>.arming`). */
export function clearModelSwitch(sessionId: string): void {
  const target = markPath(sessionId)
  if (!target || !modelRoot) return
  try {
    const prefix = `${sessionId}.`
    for (const name of fs.readdirSync(modelRoot)) {
      if (name === sessionId || name.startsWith(prefix)) fs.rmSync(path.join(modelRoot, name), { force: true })
    }
  } catch {
    // A missing directory has no mark.
  }
}
