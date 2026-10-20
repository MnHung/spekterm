---
title: Data and network
description: What spekterm connects to, which programs it starts that connect on their own, and where your data is stored.
sidebar:
  order: 3
---

spekterm has no account, no telemetry, and no update check. This page lists every connection it makes
itself, and the programs it starts that make connections of their own.

## What spekterm itself connects to

- **Slack** — only after you save Slack credentials in **Settings → Integrations**, and only to Slack's API or
  to the endpoint you set there (Settings warns that your credentials are sent to that endpoint). Without
  credentials, spekterm's Slack integration does nothing. See [Inbox and Slack](/docs/using/inbox-and-slack/).
- **Remote images in rendered markdown** — markdown that spekterm renders (files you open, OpenSpec
  artifacts in the side panel, the conversation view) may contain `https:` images. spekterm loads them from
  where they point. It does not load plain `http:` images.
- **Links you open** — a link you click is handed to your web browser; spekterm does not load it.

Nothing else. In particular, spekterm turns off the spell checker built into its browser engine, which would
otherwise download a dictionary from a third-party server at startup.

## Remote access (off unless you turn it on)

When you turn on **remote access**, spekterm **listens** for connections on one port (47615 unless you change
it) on every network interface, so the spekterm app on your phone can reach it over your LAN, Tailscale, or
a port you forward. Only devices you paired can use the connection. Each one connects over TLS to the
certificate it checked when pairing, and authenticates with its own credential, which you can revoke.
**Remote access makes no connection of its own**: it only answers your devices, and your phone learns of
events only while it is connected. No push service, relay, or server run by the project is involved. While
remote access is off, nothing listens. See [Remote access](/docs/using/remote-access/).

## Programs spekterm starts, which connect on their own

spekterm runs programs you installed. What they send is up to them, and **spekterm's own checks cannot
observe what these programs do**:

- **`claude`** (Claude Code) — every agent session runs the real `claude` CLI with your own login, and
  `claude` talks to Anthropic's service. The conversation report ("Reading") also runs your `claude`, only
  when you ask for one. Before it does, it shows exactly what will be sent and asks you.
- **`openspec`** — the side panel runs the OpenSpec CLI to read your changes. The OpenSpec CLI sends
  anonymous usage statistics unless you turn them off. To turn them off in a way that works however
  spekterm is started, run:

  ```bash
  openspec config set telemetry.enabled false
  ```

  The environment variables `OPENSPEC_TELEMETRY=0` and `DO_NOT_TRACK=1` also work, but only when they are in
  the environment spekterm itself was started with. A value set in `.zshrc` does **not** reach `openspec`
  when you start spekterm from the desktop menu (or, on macOS, from the Dock or Finder). spekterm reads your
  login shell's environment once at startup and gives it to the terminals it opens, but takes only `PATH`
  from it for its own process.
- **Your login shell** — runs once when spekterm starts, to read your environment (for example `PATH`).
  Whatever your shell configuration does at login happens then.

## Where your data is stored

Everything spekterm keeps is on your machine, under `~/.config/Spekterm` on Linux and
`~/Library/Application Support/Spekterm` on macOS:

- your workspace (the folder list, the order, what is pinned) and the side panel's position per folder;
- your sessions, and the last screen of each shell session so it can be replayed after a restart;
- your preferences;
- the inbox and handoff files;
- a copy of your Claude Code conversations for the conversation numbers and readings, and the readings
  you generated;
- your Slack credentials, in a file of their own that only your user account can read or write. The file
  is not encrypted: anyone who can read files as your user account can read it;
- remote access: its settings, its certificate, and your paired devices (`remote.json`, readable only by your
  user account; it stores a hash of each device's credential, not the credential), and the certificate's
  private key in the same file as the Slack credentials;
- files your phone attached to a message (`remote-attachments`, one folder per session, readable only by your
  user account). They are deleted when you close the session; unsent ones after a day; any of them after
  30 days.

spekterm also **reads** Claude Code's own transcripts under `~/.claude/projects` to show the conversation
view. It never writes there.

## When spekterm runs without a window (macOS)

On macOS, closing the window does not quit spekterm. While it runs without a window, the inbox keeps
receiving deliveries, and if you saved Slack credentials, spekterm keeps checking Slack every five minutes.
If remote access is on, spekterm keeps listening, and a paired phone can still connect and see the inbox
(sessions need the window). Quit spekterm (`Cmd+Q`) to stop all of this.
