## MODIFIED Requirements

### Requirement: The documentation states the app's network behavior

spekterm's documentation SHALL state, in a page about data and network:

- what the app itself connects to and when: Slack (or the endpoint the user configured) only after Slack
  credentials are saved; remote `https:` images in rendered markdown; links the user opens, in the user's
  browser;
- the update check: that a packaged build contacts GitHub (the releases of `spekhq/spekterm`, and on Linux the
  download of a newer AppImage) shortly after startup and periodically, that it sends nothing but the requests
  themselves, that it is on by default and how to turn it off, and that the integrity of an update rests on the
  GitHub release it comes from;
- that the app listens for connections only while the user has turned remote access on. At that time it
  listens on the configured port on every network interface, only paired devices can use the
  connection, and the feature itself connects to nothing: a phone is told of events only over its own
  connection;
- which programs the app starts that make their own connections: the `claude` CLI; the `openspec` CLI,
  including that it sends anonymous usage statistics and how to turn them off in a way that works however
  spekterm is started; and the user's login shell at startup;
- that the app's own checks cannot observe what those programs do.

The page SHALL be revisited whenever the app's network allow-list (`workspace-app-shell`) changes; the
allow-list names this page.

#### Scenario: The page states the app's own connections and the started programs

- **WHEN** spekterm's data and network page of the built site is read in either language
- **THEN** it names Slack, remote images, the `claude` CLI, the `openspec` CLI with its usage statistics and
  the `openspec config set telemetry.enabled false` opt-out, and the login shell, and says the app cannot
  observe the started programs' connections

#### Scenario: The page states remote access

- **WHEN** spekterm's data and network page of the built site is read in either language
- **THEN** it states that the app listens only while remote access is on, that only paired devices can use the connection, and that remote access makes no outbound connection of its own

#### Scenario: The page states the update check

- **WHEN** spekterm's data and network page of the built site is read in either language
- **THEN** it names GitHub as the update check's destination, says the check is on by default, and names the
  setting that turns it off
