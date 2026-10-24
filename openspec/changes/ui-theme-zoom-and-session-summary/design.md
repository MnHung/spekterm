## Context

See proposal.md for why. The current state that shapes the approach:

**Colors**

- **Colors are already tokens.** `index.css` declares the palette once in `@theme` (`--color-shell` …
  `--color-scrim`, 15 values, from the mockup), used through Tailwind utilities (about 860 uses). The
  `@spekjs/ui` contract (`--spek-*`, 9 variables) is mapped onto those tokens in the same file. Three modules
  hold color literals: the terminal wrapper (`shell/terminal/xterm.ts`, 5 values, no ANSI palette — xterm's
  defaults, made for a dark background), the editor wrapper (`editor/index.tsx`, `vs-dark` with 5 overrides) and
  the status dots' glow (`session-badge.tsx`, 3 `rgba` shadows). A few palette classes remain (`bg-black/50`
  ×4, `bg-black/40`, one `bg-white`, two `bg-emerald-400`).
- **`@spekjs/ui`'s `SpecGraph` resolves its colors with `getComputedStyle` when it draws** and writes them into
  SVG attributes; it redraws only when its `themeKey` prop changes, which `VizView.tsx` does not pass. Timeline
  draws with `var()` and follows by itself.
- **Measured contrast of today's dark palette**: `ink-faint #5b6675` on `hover #1b2027` is 2.81:1.
- The main window's initial background is the literal `#0a0c0f` (`src/main/index.ts`).

**Theme switch (measured, Electron 43.5.0, throwaway apps)**

- Maintainer's desktop (GTK `Yaru-dark`): `nativeTheme.shouldUseDarkColors` true, renderer `prefers-color-scheme:
  dark` matches. **Under `xvfb-run` both are false**; with `GTK_THEME=Adwaita:dark` both are true.
- Changing `themeSource` at run time (dark → light → dark → system) fired `change` four times on a `matchMedia`
  list the renderer already held, and `@media` rules recomputed.
- **`dialog.showMessageBox` on Linux is drawn by GTK and ignores `themeSource`**: screenshots under `light` and
  `dark` are pixel-identical.

**Zoom (measured)**

- There is no zoom today: the native menu, and with it Chromium's accelerators, is removed.
- `setZoomFactor(1.5)`: `devicePixelRatio` 1.5, `innerWidth` 800 → 533.
- **Chromium remembers a zoom per page, keyed by the full URL** (`per_host_zoom_levels`, key `file:///…/index.html`).
  Unpackaged, the URL is stable and the remembered zoom is the next start's zoom. **Packaged, the AppImage mounts
  at a random path each start**, so the remembered zoom never matches and each start would begin at 100%.
- **When the zoom is applied matters**: applied on `did-navigate`, the page's first script already sees the new
  zoom; on `dom-ready` or `did-finish-load` it sees the old one, and the terminal would first fit at the wrong
  size and send the pty an extra resize.
- **Wheel `deltaY` is in CSS pixels**, so it shrinks with the zoom: the same CDP wheel event of -120 arrives as
  -80 at 150%.
- CDP's `Input.dispatchMouseEvent` at 150% hits the element at its `getBoundingClientRect` (CSS) coordinates;
  multiplying by `devicePixelRatio` misses.
- Electron does not zoom by itself on `Ctrl`+wheel.
- xterm 6 sends no byte for `Ctrl` with `=`, `-`, `0` or the keypad keys; `Ctrl+Shift+-` sends `^_`. But
  **xterm's wheel handlers ignore `defaultPrevented`**: on the alternate screen it turns a wheel into arrow keys
  for the pty, and with mouse tracking on it reports the wheel. Only the viewport's scroll checks it.
- `@spekjs/ui`'s Graph uses d3-zoom, whose default filter lets a `Ctrl`-wheel through.
- `KeyboardNavigation.tsx` returns early on `altKey || metaKey`, before any shortcut.

**Header and sessions**

- Every session of every rail item is in `useSessions().all()` — **including sessions of a folder that left the
  workspace** (removing a folder does not close them; `lineage.tsx` says so).
- Each running agent session's attention is the main process's projection (`useAttention().attentionOf`); the
  rail turns it into a `RowState` (`rowStateOf`), drawn by `StateDot`, ranked by `URGENCY` (not exported).
- `LineageProvider`'s `jumpTo(folderId, sessionId)` = select the item + `sessions.focus`, the rail row's path.
  Focusing gives the terminal (or Wake) keyboard focus.
- `useScrollIntoView` skips a container while its own `mousedown` flag is set, reset only by a keydown — a
  click on the header after any click on the rail would leave the rail unscrolled.
- The header is `name | path | spacer | panel switch, collapse, maximize`. In a mock (15-px text) the right-hand
  controls take 430 px in English, 367 px in Traditional Chinese; four states with words 453 px, dots and
  counts only 97 px. The `<main>` minimum is 360 px, where today's header already overflows; the default
  window gives the stage about 960 px. Four probes read the selected item from the header's first line.

## Goals / Non-Goals

**Goals:**

- One switch decides light or dark for everything spekterm and the engine draw, with no reload.
- The stored zoom is the only zoom, from the page's first script.
- A missed color literal or a wrapper palette drifting from its token is caught by `npm test`.
- One glance at the header answers "does anything need me, anywhere?", and one click goes there, from data
  the renderer already holds.

**Non-Goals:**

- Changing Claude Code's own colors or the operating system's dialogs.
- Per-repo themes, a palette editor, a high-contrast theme.
- Changing `--text-base` or the terminal font preference: zoom is a separate, multiplicative layer.
- Fixing the header's existing overflow at the 360-px minimum (the summary must not make it worse).
- A shortcut for "next session that needs me", per-session activity text, the summary on the phone.

## Decisions

### D1. `nativeTheme.themeSource` is the one switch; the renderer reads `prefers-color-scheme`

Main sets `nativeTheme.themeSource` from the preference before creating the window and on every change, and on
`nativeTheme`'s `updated` event calls `setBackgroundColor` with the resolved palette's shell color (the window
background otherwise shows the old palette on a reload or when the window grows). The renderer never reads the
preference to decide colors: CSS uses `@media (prefers-color-scheme: light)`, and the JavaScript consumers
(terminal, editor, Graph) use one hook over `matchMedia('(prefers-color-scheme: dark)')`.

*Alternative: a `data-theme` attribute set from the preference.* System would need main to push OS changes,
and engine-drawn controls would not follow. Rejected. The run-time `change` was measured (Context).

### D2. Light is a second set of values for the same tokens; dark's faintest text is raised

`index.css` keeps `@theme` (dark) and adds `@media (prefers-color-scheme: light) { :root { … } }` with one value
per color token; `:root` declares `color-scheme: light dark`. Utilities, opacity modifiers (`color-mix` over the
variable, checked in the built CSS) and the `--spek-*` mapping all read the variables.

| token | dark | light |
|---|---|---|
| shell | `#07090c` | `#fbfcfd` |
| rail | `#0a0c0f` | `#f1f3f6` |
| stage | `#0f1216` | `#f7f8fa` |
| panel | `#14181d` | `#ffffff` |
| hover | `#1b2027` | `#e8ecf1` |
| hairline | `#1e242c` | `#d4dae2` |
| ink | `#e2e8f0` | `#0f172a` |
| ink-dim | `#94a3b8` | `#475569` |
| ink-faint | **`#6b7786`** (was `#5b6675`) | `#6b7686` |
| accent | `#f59e0b` | `#b45309` |
| danger | `#f87171` | `#dc2626` |
| accent-soft | `rgba(245,158,11,.12)` | `rgba(180,83,9,.12)` |
| blue | `#60a5fa` | `#2563eb` |
| green | `#34d399` | `#059669` |
| scrim | `rgba(0,0,0,.5)` | `rgba(15,23,42,.35)` |

Dark `ink-faint` was 2.81:1 on `hover`; `#6b7786` is 3.59:1 at its worst. It departs from the mockup's value,
for the reason the change exists (too dark to read). The light values' worst cases: green on hover 3.18,
ink-faint on hover 3.88 (reviewer's computation; the test in D5 is the judge).

Leftover literals: the dots' glow becomes `color-mix` over `--color-accent` / `--color-green`; `bg-black/50|40`
→ `bg-scrim`; `bg-emerald-400` → `bg-green` (Tailwind's `emerald-400` is `oklch(76.5% 0.177 163)`, about `#00d492`, a shade from
`#34d399`; "running MAY look like working" in `session-wait-indicator`, and working keeps its glow). The remote pairing QR code keeps black on white in both
themes — a scanner needs it — as the named exception.

### D3. The terminal, the editor and Graph switch on the theme hook

- **Terminal**: the wrapper holds a dark and a light theme and sets `terminal.options.theme` on change (xterm
  redraws, WebGL included, without touching the pty). The light theme adds a 16-color ANSI set for a light
  background ("white" entries are dark greys), a light `selectionBackground` (the dark one, `#243044`, is a
  wrapper-owned value with no token, and stays so), and **`minimumContrastRatio: 4.5`**: the pty runs with
  `TERM=xterm-256color`, and Claude Code's 256-color and true-color output bypasses the 16-color palette;
  xterm raises a foreground to the ratio at draw time (WebGL addon included) — half the ratio for dim text, and
  none for glyphs it draws as shapes (box drawing), which the spec states. Dark keeps xterm's defaults and no
  ratio, as today.
- **Editor**: a `vs`-based light theme with the five overrides from the light tokens; `monaco.editor.setTheme`
  on change. The dark theme's line-number color (`#5b6675`, the old `ink-faint`) moves with the token.
- **Graph**: `VizView` passes the hook's value as `SpecGraph`'s `themeKey`, so a change while Graph is shown
  redraws it.
- Wrappers hold literals (xterm and Monaco take no CSS variables; reading tokens at run time would couple them to
  the DOM and to `@theme`'s tree-shaking). `scripts/theme-palette.test.mjs` parses `index.css` and fails when a
  wrapper color differs from the token it stands for.

### D4. Zoom: the window's zoom factor, applied by main on every navigation

Main calls `webContents.setZoomFactor(zoom / 100)` on every `did-navigate` and on every zoom change. `did-navigate`
is early enough that the page's first script runs at the stored zoom (measured), so neither Chromium's per-URL
memory nor a reload decides it, and the terminal's first fit is already right.

- **Steps** in `src/shared/appearance/zoom.ts` (`test:unit` globs one directory level under `src/shared/`): `[50, 67, 75, 80, 90, 100, 110, 125, 150, 175]`. The top is 175 because at
  200% a 1280-px window is 640 CSS px, below the regions' minimums with the side panel open (52 + 3 + 180 + 240
  + 3 + 240 = 718; 175% gives 731). Off-step values snap to the nearest, the smaller on a tie.
- **The main stage's minimum becomes 483 px** (found in apply): it was 360, below its own two columns' 240 + 3 +
  240, so at 175% the rail kept its 260 px and the columns were squeezed past their minimums. With 483 the outer
  group narrows the rail toward its 180 instead.
- **Stepping is computed in main** (`stepZoom(-1 | 0 | 1)`), through `PreferencesProvider`'s queue like every
  write; Settings writes an exact step with `setZoom(percent | null)`. Both return the projected preferences, so
  Settings follows — every zoom request starts in the renderer, so no push channel is needed.
- **Keys**, in `KeyboardNavigation`'s window capture listener, **before** its `altKey || metaKey` early return,
  and outside the dialog/menu suppression: with `Ctrl` (`Meta` on macOS) and without `Alt` (`AltGr` is `Ctrl+Alt`
  on some layouts), `event.key` `=` or `+` zooms in and `0` resets, Shift allowed for both (`Ctrl++` on a US
  layout is Shift+`=`; AZERTY needs Shift for the main row's `0`; xterm sends nothing for either); `-` zooms out
  **only without Shift** (`Ctrl+Shift+-` is `^_` and keeps reaching the pty); the keypad by `event.code` (`NumpadAdd`,
  `NumpadSubtract`, `Numpad0`). `event.key` follows the layout, as the repo's other shortcuts do.
- **Wheel**: one window capture `wheel` listener (`passive: false`) that, with `ctrlKey`, calls
  `preventDefault()` and stops propagation — that, not `preventDefault`, is what keeps it from xterm (whose wheel
  handlers, bound in the bubble phase on its elements, ignore `defaultPrevented`) and from Graph's d3-zoom (on its
  svg, same document). `deltaY` is converted to device pixels
  (× the current zoom; × line height or page height for `deltaMode` 1/2). An event of at least 40 device pixels
  is one notch — one step; smaller events accumulate until 100 and reset after 300 ms of quiet. A long touchpad
  gesture therefore takes several steps, in proportion to its length; that is the promise, not "one gesture, one
  step". Dogfood
  on the maintainer's Linux desktop (2026-10-24): one `Ctrl`+notch of a real mouse zooms exactly one step, so a
  notch reaches 40 device pixels and the threshold stays; the raw `deltaY` was not logged.
  *Alternative: Electron's `zoom-changed`.* No magnitude, so a touchpad runs the zoom to an end. Rejected.
- **`Ctrl`+wheel is taken from programs in the pty** that use mouse reporting; none of `claude`, zsh or bash
  uses it.

### D5. Preferences, guards

`theme: 'system' | 'light' | 'dark'` and `zoom: number` in the `ui` group, `toRenderer: true`, sanitized like the
others (unknown theme → absent; zoom snapped; non-number → absent). `setTheme`, `setZoom`, `stepZoom` join the
preload whitelist, and `probe:shell`'s list of allowed settings methods.

- `scripts/theme-contrast.test.mjs`: both palettes from `index.css` (ink, ink-dim ≥ 4.5 against shell, rail, stage,
  panel, hover; ink-faint, accent, danger, blue, green ≥ 3), and the light terminal's ANSI colors ≥ 3 against its
  background. Control: the dark accent placed in the light palette fails; the old dark `ink-faint` fails.
- `scripts/color-literal.test.mjs`: no hex, `rgb[a]()` or palette color class in renderer source outside
  `index.css`, the two wrappers and the QR exception. Control: a sample with `bg-white` and `#123456` fails.

### D6. Probes pin the theme as they pin the language

`scripts/lib/probe-language.mjs`'s seed writes `theme: 'dark'` with the language, so the probes and
`capture:screenshots` keep the dark palette under `xvfb-run` (`probe-openspec` asserts a dark green value).
Sections that write their own `preferences.json` (in `probe-remote`, `probe-terminal`, `probe-intake`,
`probe-agent-view`, `probe-workspace`) will run in light; none compares a color today. `GTK_THEME` in the
developer's shell would flip System on the virtual display; the probe runner clears it.

**Discriminating restart checks.** Unpackaged, Chromium's per-URL memory makes "the zoom survives a restart"
green even if main never applies the preference; so the restart section first sets 150% (which Chromium records),
then writes 125% into `preferences.json`, then restarts and asserts 125% from the page's first script. The theme's
restart check stores Dark on a virtual display whose System is light. A reload check that cannot be made to
disagree is marked `greenIfAbsent: true` in the coverage table.

**Every zoom section resets to 100% in a `finally`**, so that a section that throws midway does not leave later
sections — which click at real mouse coordinates — at another zoom.

### D7. The header summary: counted set and order from the rail's own inputs

- `summarize(states)` in `src/shared/wait/summary.ts`: `RowState` (from `rowStateOf`) → buckets in `URGENCY`
  order (exported), `ended` last: `choice`+`waiting` → needs you; `error`; `working`; `running`+`unknown` →
  running; `idle`; `dormant` → hibernated; `ended`. Empty buckets absent.
- `railSessionOrder(items, sessionsOf, present)` in `src/renderer/src/shell/rail-order.ts`, beside
  `session-forest.ts`. **The counted set is what the rail lists**: the global item's and each workspace folder's
  sessions (`sessions.forFolder(null)` / `forFolder(folder.id)`), the global item first, then the pinned
  folders, then the rest. A removed folder is not an item, so its sessions are out by construction. Within an
  item the order is `buildForest`'s depth-first order, where `present` (the rail's `useLineage().exists`) only
  decides **who can be a parent** — as in the rail. **`exists` is not a filter**: it is false for an ended
  session, which the rail still lists and the summary counts (`error`, `ended`); a child whose parent ended is a
  top-level row, as on the rail.
- `WorkspaceRail` takes its item split and forest inputs from it; the rail still renders through its own
  recursion, so the probe asserts the jump sequence equals the rail's DOM row order — that, not the shared code
  alone, keeps the two together.
- The total is not shown in the header. (The status bar's total, `sessions.all().length`, also counts a removed
  folder's still-running sessions; the two are different questions and are not reconciled here.)

### D8. The jump is `jumpTo`; focus and scrolling behave as for a rail row click

`MainStage` calls `useLineage().jumpTo` for the next session after the focused one in `railSessionOrder` (from
the start when none; wrapping). A bucket whose only session is focused re-focuses it, which bumps the sessions
context's attention counter like a rail click (the maximized side panel restores) — deliberately the same.
Keyboard focus goes into the session (or Wake), as from a rail row; "activate again to go on" is a mouse behavior.
*Alternative: keep focus on the summary.* It would make the summary unlike the row it mirrors and leave the user
unable to type into the session they went to. Rejected.

**A collapsed rail item is not expanded** (its collapse is the user's): the rail scrolls the item's row into view
instead of the session's row, which is not in the DOM; the item row's dot already says what is inside. The rail's
existing scroll target is the session row when present, else the item row.

`useScrollIntoView`'s exception becomes: **the last input was a `mousedown` inside this container**. Any keydown
(as today) or any `mousedown` outside the container clears it. Both are window capture listeners; still
`mousedown`, for the probes' real events. A click on the header therefore lets the rail and the tab strip scroll
to the target; a click on a rail row still does not scroll the rail under the pointer; and a key after a rail
click scrolls again, as today.

Found in apply: the rail has two targets in one commit when the selection changes — the item's row (the rail's
guard) and the focused session's row (the item's guard). A child's effects run before its parent's, so the item
row won and, in a short rail, scrolled the session row out again. When the focused session changes in the same
commit as the selection (a jump to a session: the summary, a lineage marker), the session row's guard scrolls last
(a microtask after the commit's effects); selecting the item alone (`Ctrl+↓`, a click on its row) keeps the item's
row winning, as `probe:keyboard` requires.

### D9. The header gives way in a measured order

`name | summary | spacer | controls`, the name the header's first child (four probes read it). The controls are
**not** `shrink-0` (found in apply): before the summary their labels wrapped in a narrow header rather than leave
it, and `shrink-0` pushed them out at 150% and 175%; the summary measures their natural (`max-content`) width
instead, so it never takes the room they need on one line. A `ResizeObserver` on the header measures the room left after the controls and the name's minimum
(`min-w-[8ch]`): the summary shows words if all fit, else dots and counts, else as many of the most urgent states
as fit with the rest folded into one `+N` marker whose tooltip lists them; only then does the name truncate. A
fixed breakpoint cannot be right for both languages (their controls differ by 63 px) nor under zoom. Labels come
from `t(key, { count, state })`, which the `aria-label-source` guard allows.

The path stays on the rail row's tooltip; `stage.globalHint` is removed (nothing refers to it). The mockup's
`.repo-header-agg` becomes the workspace summary, so the mockup stays the authority on this element.

## Risks / Trade-offs

- [A light value passes the contrast test but looks wrong, e.g. hover too close to its surface] → the test bounds
  text only; the look is judged by dogfood on the maintainer's screen and a projector (probes prove resources,
  not pixels).
- [Raising dark `ink-faint` changes the dark look the mockup set] → one token, faint text only; recorded as a
  deviation the user approves at review.
- [Fractional zoom steps (67, 90, 110, 125, 175%) give a fractional device pixel ratio; the terminal's DOM renderer
  fallback shows hairline seams there (`docs/lessons/terminal.md`)] → dogfood; the WebGL renderer is the default.
- [`minimumContrastRatio` changes the hue of very light colors in Light] → that is its purpose; dark keeps none.
- [Dots alike without words (working/running, hibernated/ended)] → the tooltip and accessible name tell them
  apart; written into the spec.
- ["Looking at it lowers the count" needs window focus, which the virtual display may not give] → the probe checks
  `document.hasFocus()` first, as `runAttention` does, and records a gap; `looked-at.test.ts` carries the rule.
- [Packaged, each start's random mount path adds one `per_host_zoom_levels` entry to Chromium's profile whenever the
  zoom is not 100%] → a few bytes per start, never read; accepted.
- [`useScrollIntoView` and the rail ordering touch every scrolling container and the rail] → `probe:keyboard`,
  `probe:workspace` and the lineage sections of `probe:intake` must stay green.
- [The `auto-update` change (committed, not archived) edits the same store, provider and Settings, and the same
  requirement] → apply on top of its commit; archive this change only after `auto-update` is archived.
- [Default System turns the app light for users whose system is light] → intended, as in the Android app.

## Migration Plan

None beyond defaults: an existing `preferences.json` has neither field and reads as System and 100%. Rolling back
is safe: an older version keeps only `language` from the `ui` group and drops the two fields at its next write.

## Open Questions

- None. The notch threshold was settled by dogfood (D4).
- Not taken, by the maintainer's choice after dogfood: icon-only header controls when the header is narrow. At
  150–175% zoom on a 1280-px window the summary is hidden and the controls' labels wrap; that stays as is.
