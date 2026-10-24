# ui-appearance Specification

## Purpose
How the interface looks to the person reading it: a light or a dark palette chosen by the user or by the
system, and a zoom that makes the whole interface larger or smaller. Both exist so that spekterm can be read
in a bright room or on a projector, not only on a laptop at arm's length.

## Requirements

### Requirement: The user chooses the theme: System, Light or Dark

The preferences SHALL hold a theme with three values: **System**, **Light** and **Dark**, the same choices
as the companion Android app. **System SHALL be the default**, and SHALL follow the operating system's
light or dark appearance, including a change of it while the application runs.

A stored value the application does not recognize, or no stored value, SHALL be read as System. Adding the
theme SHALL NOT bump the preferences file's version (see `terminal-preferences`).

A change of theme SHALL apply at once, without a restart and without reloading the interface: no session,
open file or unsaved edit SHALL be affected by it.

**Known gap: following an operating system change while the application runs has no automated carrier** (the
probes cannot change the appearance of a running desktop); it is judged by dogfood. Following the appearance
the system has at start is carried.

#### Scenario: Choosing Light applies at once

- **WHEN** the theme is Dark and the user chooses Light in Settings
- **THEN** the interface shows the light palette, and every session is still running with its content

#### Scenario: System follows the operating system

- **WHEN** the theme is System and the operating system's appearance is dark
- **THEN** the interface shows the dark palette

#### Scenario: The theme survives a restart

- **WHEN** the user chooses Dark on a system whose appearance is light, and restarts the application
- **THEN** it starts with the dark palette, and Settings shows Dark

#### Scenario: An older preferences file reads as System

- **WHEN** the preferences file was written before the theme existed
- **THEN** the theme is System and every other preference is unchanged

#### Scenario: An unknown stored value reads as System

- **WHEN** the stored theme is a value this version does not know
- **THEN** the theme is System, and the file is not quarantined

### Requirement: The chosen palette covers everything spekterm draws

Under either palette, every surface spekterm draws SHALL use it: the shell (activity bar, rail, main stage,
status bar), dialogs and menus drawn by the interface, the side panel including the views supplied by
`@spekjs/ui` (Graph, Timeline) — also when the theme changes while they are shown — the file viewer and
editor, the agent conversation view, and the terminal.

- The **terminal** SHALL take its background, foreground, cursor, selection and **its 16-color ANSI palette**
  from the palette in use. Under the light palette it SHALL also raise the contrast of the text colors it
  draws — 256-color and true-color output included, which bypasses the 16-color palette — to at least
  4.5:1 against its background for normal text and at least half that for dim (faint) text, so that a
  program written for a dark terminal stays readable. Box-drawing and similar glyphs drawn as shapes are
  exempt.
- The **editor** SHALL use a light or a dark editor theme matching the palette, including its syntax colors.
- The controls the browser engine draws (scrollbars, form controls) SHALL follow the same light or dark
  choice.
- The window's background SHALL match the palette in use, before the interface has loaded and after a change
  of theme, so that the window does not flash the other palette.

**Known limit: the operating system's own dialogs** (the confirmation asked when the window is closed with
running sessions, the file chooser) follow the operating system's theme, not this choice: on Linux they are
drawn by GTK (measured: they are identical under either choice). The user-facing documentation SHALL say so.

The colors a program inside a terminal chooses for itself remain its own: Claude Code's colors follow Claude
Code's own theme setting, which spekterm SHALL NOT change; the contrast floor above only keeps them readable.
The user-facing documentation SHALL say so.

Each palette SHALL keep text readable on the surfaces it is drawn on: primary and secondary text SHALL have a
contrast ratio of at least 4.5:1 against every surface color of the same palette (shell, rail, stage, panel,
hover), and the faintest text, the accent, the danger color, blue and green at least 3:1.

#### Scenario: The terminal follows the theme

- **WHEN** a terminal session is shown and the user switches from Dark to Light
- **THEN** the terminal's background and foreground become the light palette's, without the session restarting

#### Scenario: ANSI colors come from the light palette in Light

- **WHEN** the theme is Light
- **THEN** the terminal's 16 ANSI colors are the light palette's, each at least 3:1 against the light terminal background

#### Scenario: Output colored for a dark terminal stays readable in Light

- **WHEN** the theme is Light and a program prints text in a light true color meant for a dark terminal
- **THEN** the terminal draws that text with a contrast of at least 4.5:1 against its background

#### Scenario: The editor follows the theme

- **WHEN** a file is open in the side panel and the user switches the theme
- **THEN** the editor's background and syntax colors switch to the matching editor theme, and an unsaved edit is still there

#### Scenario: The side panel's Graph follows a change while shown

- **WHEN** Graph is shown and the user switches from Dark to Light
- **THEN** Graph is redrawn with the light palette's colors without being closed and reopened

#### Scenario: Each palette meets the contrast floor

- **WHEN** the contrast of each palette's text colors is computed against each of its surface colors
- **THEN** primary and secondary text are at least 4.5:1, and the faintest text, accent, danger, blue and green at least 3:1

### Requirement: The whole interface can be zoomed

The preferences SHALL hold a zoom for the whole interface, **from 50% to 175%** in the steps 50, 67, 75, 80,
90, 100, 110, 125, 150 and 175 percent, **default 100%**. The zoom SHALL scale everything in the window
together — text, spacing, controls and the terminal — as a browser's zoom does. It SHALL NOT change the
terminal's font size preference: the terminal is scaled with the rest.

A zoom SHALL apply at once, without a restart, and the terminal SHALL measure its rows and columns again so
that its pty is told the new size. A stored value that is not one of the steps SHALL be read as the nearest
step, the smaller one when it lies halfway; no stored value SHALL be read as 100%.

**The stored preference SHALL be the only thing that decides the zoom**, from the first script the interface
runs: the browser engine's own memory of a zoom per page SHALL NOT decide it, at start or after a reload.

At every step, on a window of 1280×720 device pixels, every region of the layout SHALL be able to keep at
least its declared minimum width with the side panel expanded.

#### Scenario: Zooming in makes everything larger

- **WHEN** the zoom is 100% and the user zooms in one step
- **THEN** the zoom is 110%, text and controls are drawn larger, and the terminal shows fewer columns than before, which its pty has been told

#### Scenario: The zoom survives a restart, whatever the engine remembers

- **WHEN** the stored zoom is 125% and the browser engine remembers 150% for the interface's page, and the application starts
- **THEN** the interface's first script already runs at 125%

#### Scenario: Zooming stops at the ends

- **WHEN** the zoom is 175% and the user zooms in
- **THEN** the zoom stays 175%

#### Scenario: A reload keeps the stored zoom

- **WHEN** the stored zoom is 125%, the engine remembers another zoom for the page, and the interface is reloaded
- **THEN** the zoom is 125% after the reload

#### Scenario: The largest zoom keeps every region at its minimum

- **WHEN** the window is 1280×720, the side panel is expanded and the zoom is 175%
- **THEN** the activity bar, the rail, the terminal column and the side panel are each at least their declared minimum width

### Requirement: Keys and the mouse wheel change the zoom

`Ctrl+=` and `Ctrl++` SHALL zoom in one step, `Ctrl+-` SHALL zoom out one step, and `Ctrl+0` SHALL reset to
100%; on macOS `Cmd` SHALL take the place of `Ctrl`. The keys on the numeric keypad SHALL do the same.
`Ctrl+Shift+-` SHALL NOT zoom: it is `^_` (undo in readline and zsh) and SHALL keep reaching the pty. `Ctrl+0`
SHALL also reset when Shift is held, because some layouts (AZERTY) need Shift for the main row's `0`, and xterm
sends nothing for it. A combination that includes `Alt` SHALL NOT zoom (`AltGr` is `Ctrl+Alt` on some layouts).

`Ctrl` with the mouse wheel SHALL zoom in (wheel up) or out (wheel down) one step per notch of a mouse wheel,
at every zoom. Small continuous movements (a touchpad's scroll or pinch) SHALL add up to a notch's worth before they
zoom one step, so that a gesture moves the zoom in proportion to its length rather than one step per event. A `Ctrl`-wheel SHALL zoom the interface wherever
the pointer is, the side panel's Graph included, and SHALL NOT reach what is under the pointer: it SHALL NOT
scroll, SHALL NOT zoom the Graph, and SHALL NOT send anything to the pty, whatever mode the terminal is in.

These keys and the wheel SHALL take effect with focus anywhere in the window, including the terminal, the
editor, and while a dialog or a menu is open: zooming does not move focus, select anything or answer the
dialog. The keys SHALL NOT reach the pty. A zoom changed this way SHALL persist exactly as one changed in
Settings, and Settings, if open, SHALL show it.

#### Scenario: Zooming from the terminal

- **WHEN** focus is in the terminal and the user presses `Ctrl+=`
- **THEN** the zoom grows one step and the pty receives no bytes for the key

#### Scenario: `Ctrl+Shift+-` still reaches the pty

- **WHEN** focus is in the terminal and the user presses `Ctrl+Shift+-`
- **THEN** the zoom is unchanged and the pty receives `^_`

#### Scenario: Resetting from the editor

- **WHEN** the zoom is 150%, focus is in the editor and the user presses `Ctrl+0`
- **THEN** the zoom is 100% and the editor's content is unchanged

#### Scenario: Zooming while Settings is open

- **WHEN** Settings is open on General and the user presses `Ctrl+-`
- **THEN** the zoom shrinks one step, Settings stays open, and its zoom control shows the new value

#### Scenario: Zooming with the wheel

- **WHEN** the user turns the mouse wheel up one notch while holding `Ctrl` over the terminal, at 100% and again at 150%
- **THEN** each notch grows the zoom one step and the terminal does not scroll

#### Scenario: A `Ctrl`-wheel over a full-screen program sends nothing

- **WHEN** a program in the terminal uses the alternate screen and the user turns the wheel while holding `Ctrl` over it
- **THEN** the zoom changes and the pty receives no bytes

#### Scenario: A `Ctrl`-wheel over Graph zooms the interface, not the graph

- **WHEN** Graph is shown and the user turns the wheel while holding `Ctrl` over it
- **THEN** the interface zoom changes and the graph's own scale does not

#### Scenario: A touchpad gesture does not jump to an end

- **WHEN** the zoom is 100% and the window receives a run of `Ctrl` wheel events whose movements together equal one notch
- **THEN** the zoom is 110%
