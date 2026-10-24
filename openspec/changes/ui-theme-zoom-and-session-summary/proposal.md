## Why

In a live demo on a projector the app could not be read: spekterm has only a dark palette, and the text is
sized for a laptop at arm's length. The companion Android app already lets the user choose System / Light /
Dark; the desktop has no choice at all, and since the native menu bar was removed it does not even have the
browser's `Ctrl+=` zoom.

The same demo showed the main stage's header spending its space on the selected repo's absolute path, which
the user rarely needs, while the question they keep asking — "is anything waiting for me?", across every
repo — is answered only by scrolling the rail for an amber dot. (The mockup's header carries an aggregate,
"2 sessions · master, feat/term", not a path; the implementation drifted from it.)

## What Changes

- **A theme preference: System, Light or Dark**, as in the Android app, **default System**. Light is a second
  palette for the same color tokens; everything that draws with them follows, including the side panel's
  `@spekjs/ui` views, the terminal (its colors, its 16-color ANSI palette, and a contrast floor for colors a
  program picks for a dark terminal) and the file editor. Engine-drawn controls follow; the operating system's
  own dialogs do not (a stated limit).
- **The dark palette's faintest text gets brighter** (`#5b6675` → `#6b7786`): it was 2.81:1 on the hover
  surface, under the 3:1 floor both palettes now share.
- **A zoom preference for the whole interface**, 50% to 175% in fixed steps, default 100%: text, spacing and
  the terminal scale together, as in a browser.
  - `Ctrl+=` (and `Ctrl++`) / `Ctrl+-` / `Ctrl+0` (`Cmd` on macOS) zoom in, out and reset, with focus anywhere,
    including the terminal and the editor; the keys never reach the pty. `Ctrl` + mouse wheel zooms too.
  - The stored preference alone decides the zoom, from the first script the page runs.
- **Settings → General** gains the theme choice and the zoom choice, next to the language.
- **The main stage's header** drops the path and keeps the selected item's name, and **counts the sessions of
  the whole workspace by state** — needs you, error, working, running, idle, hibernated, ended — with the
  rail's dots, only the states that have a session, the most urgent first. Each count goes to the next session
  in that state (selecting its rail item), so the user reaches what needs them without scrolling the rail. The
  header gives way in a fixed order when narrow: words first, then the least urgent states, then the name.

## Capabilities

### New Capabilities

- `ui-appearance`: the theme preference (System / Light / Dark), the palettes' coverage and contrast, and the
  interface zoom with its keys and wheel gesture.

### Modified Capabilities

- `terminal-preferences`: the General section of Settings holds the theme and the zoom as well as the
  language.
- `keyboard-navigation`: the zoom keys are a fifth group of shortcuts; the requirements on the terminal, the
  editor and open dialogs state their scope.
- `session-wait-indicator`: the main stage's header summarizes the workspace's sessions by the dots' states and
  leads to them.

## Impact

- **Preferences**: two new fields in the `ui` group of `preferences.json`; no version bump.
- **Main process**: `nativeTheme.themeSource` and the window's background follow the theme; the window's zoom
  factor follows the zoom, applied on every navigation.
- **Renderer**: light token values in `index.css`; the terminal and editor wrappers switch palettes; Graph is
  redrawn on a theme change; zoom keys and wheel; the header summary; `useScrollIntoView` keyed on the last
  pointer-down's container; the rail's ordering shared with the summary.
- **Probes**: profiles pin the theme to dark as they pin the language (the virtual display resolves System to
  light); new sections in `probe:workspace`, `probe:keyboard` and `probe:agent-view`; `probe:shell`'s preload
  whitelist; the website's screenshots are captured again.
- **Mockup**: the header's aggregate line becomes the workspace summary.
- **Website**: the Settings, keyboard shortcuts, and terminals-and-sessions pages, in both languages.
- **Overlap**: the `auto-update` change (committed as `e8ad816`, not yet archived) also edits the preferences store, `PreferencesProvider` and Settings; this change is applied on top of that commit. Their spec deltas overlap too: both modify `terminal-preferences`' "偏好設定介面", and this change's copy is built on `auto-update`'s version, so **`auto-update` must be archived first** to keep both.
