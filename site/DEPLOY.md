# Deploying spekterm.com

The site is published by **Cloudflare Pages' Git integration**: Cloudflare builds `site/` from
`master` and publishes it only when the build — which is also the site's gate (`README.md`) — succeeds.
A failed build leaves the previous deployment live. These steps are done once, by hand, in the
Cloudflare dashboard (account that owns the `spekterm.com` and `spekterm.app` zones).

> Every push to `master` that changes a watched path (below) becomes a production deploy.

## 1. The Pages project

Workers & Pages → Create → Pages → Connect to Git → `spekhq/spekterm`.

| setting | value |
|---|---|
| Production branch | `master` |
| Framework preset | None |
| Root directory | `site` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Environment variable | `NODE_VERSION` = the value in `site/.nvmrc` |

Then, under Settings → Builds:

- **Build watch paths** — include: `site/*`, `scripts/lib/third-party-licenses.mjs`,
  `scripts/lib/public-hygiene.mjs`, `scripts/public-hygiene.test.mjs`, `scripts/license.test.mjs`;
  exclude: nothing.
- **Branch control** — preview branches: **None** (branches pushed from elsewhere must not get public
  preview URLs).

### What the first deploy showed (2026-10-08)

| item | outcome |
|---|---|
| The build reads files outside the root directory (`../scripts/...`) | Yes — the root content guards and the notices helpers ran from `site/` |
| The clone has `git` and a `.git` directory | Yes |
| The clone carries tags | **No** — the version check stopped the first build, as designed. The build command is `git fetch --tags --force && npm run build` |
| Node version | `NODE_VERSION` was picked up (nodejs 22.22.0) |
| GitHub connection | Installing the GitHub App from GitHub's side left Cloudflare unlinked ("internal issue with your Cloudflare Pages Git installation"); uninstalling it and installing again from the dashboard's *Connect GitHub* fixed it. The app has access to `spekhq/spekterm` only |
| Watch paths and preview branches | Set through the API (`path_includes` as above, `preview_deployment_setting: none`) |

The project was created through the Pages API with the maintainer's `wrangler` login; the settings above
are what it holds.

The build fetches spek's demo from `raw.githubusercontent.com` (`site/README.md`); a failed fetch fails the
build, which leaves the previous deployment live.

## 2. The custom domain

Pages project → Custom domains → *Set up a custom domain* → `spekterm.com` → *Activate domain*. The
dashboard creates the proxied `CNAME` to `spekterm.pages.dev` in the zone. **A domain added through the
API does not get that record** (it stays *pending*, waiting for a manual `CNAME`) — add domains from the
dashboard.

## 3. Redirects

`www.spekterm.com`, `spekterm.app`, and `www.spekterm.app` are custom domains of the same Pages project
(Custom domains → add each). The Pages Function `functions/_middleware.js` answers them with a 301 to
`https://spekterm.com`, keeping the path and query; its logic is tested by
`scripts/site-redirect.test.mjs`. No DNS records or redirect rules are needed beyond what adding a custom
domain creates. The `*.pages.dev` host is not redirected; every page's `rel="canonical"` points at
`spekterm.com`.

## 4. Zone features that change what is served

Web Analytics, Bot Fight Mode, Email Address Obfuscation, Rocket Loader, and Automatic HTTPS Rewrites can
each inject a script, a cookie, or rewrite the HTML without any change to the repository.

**As of the first deploy they were left at the zones' defaults** (changing them needs a Zone Settings
permission the `wrangler` login does not have), and the live check found every page served byte for byte
as built with no cookie — so none of them changes the site today. Email Address Obfuscation acts only on
a page that contains an email address; no page does, but spek's demo (`/spek/demo/`) holds one in its
embedded data. Whether the obfuscation rewrites text inside a `<script>` is not confirmed; the live check
compares the demo byte for byte, so a rewrite would show there. **If the live check ever fails, turn the culprit off
in the `spekterm.com` zone's settings** and run it again. Web Analytics is off for the Pages project
(`web_analytics_tag: null`).

## 5. The live check

```bash
cd site
node scripts/check-live.mjs --commit <deployed commit>
```

It builds that commit in a temporary worktree and checks that every page, the notices file, spek's demo, and
the not-found response are served byte for byte as built, with no `Set-Cookie`, and that each redirecting host
answers 301 with the path and query kept. Run it after the first deploy and after any change to zone
settings.

## 6. The repository's homepage

```bash
gh repo edit spekhq/spekterm --homepage https://spekterm.com
```

## Rollback

Pages project → Deployments → pick an earlier deployment → *Rollback*. Removing the custom domain takes
the site offline without touching the repository.
