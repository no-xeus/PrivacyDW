# PrivacyDW fork notes

PrivacyDW is a fork of [Vencord](https://github.com/Vendicated/Vencord) that adds privacy servers
(self-hosted, optionally end-to-end encrypted guilds) and hardens Discord against telemetry.

## Branches & remotes
- `main` mirrors `upstream/main` exactly. Never commit to it.
- `privacy` holds our work. Update it with `git fetch upstream && git merge upstream/main`.
- `upstream` = Vendicated/Vencord (push disabled), `origin` = no-xeus/PrivacyDW.

## Merge-friendly rules
1. New code goes in **new directories** (`src/plugins/privacy*/`). These never conflict.
2. Changes to upstream files must be **minimal** and **listed below**, so a merge conflict is
   easy to re-apply.
3. After every upstream merge, run `pnpm build --dev && pnpm test` and smoke-test in the dev Discord.

## Changes to upstream files
| File | Change | Why |
|---|---|---|
| `src/plugins/_core/noTrack.ts` | `allowBadgeTracking` default `true` → `false` | Send no analytics events at all by default |

## Our plugins
| Plugin | Purpose |
|---|---|
| `privacyHardening` | Main process: disables crash dumps, blocks telemetry endpoints (incl. `sentry-ipc://`), and runs a fail-closed filter that cancels any Discord request mentioning a privacy-server ID (text, or binary inside settings protobuf). Renderer: privacy-ID registry and a gateway `send` guard. `PRIVACYDW_REQUEST_LOG=/path` logs request shapes (no queries or bodies). Tests: `node --test src/plugins/privacyHardening/filter.test.ts` |
| `privacyServers` | Vault + instances + sign-in + gateway client (main process); injects instance guilds/messages through Discord's own gateway pipeline and routes Discord REST calls about privacy objects to the instance. Splits mixed requests (`/read-states/ack-bulk`, `/users/@me/scheduled-events?guild_ids=`) so each side only sees its own IDs, converts form uploads (stickers) to JSON, replays unread state from READY, and lets absolute URLs (instance upload URLs) through untouched. Main process: claims privacy IDs per instance for media redirects and adds instance origins to the CSP (`@main/csp` `CspPolicies`; effective from the next page load). Routed REST calls also invoke Discord's callback-style handlers (the message queue waits on the callback, not the promise). Settings: per-instance profile (display name, bio, avatar). Data lives in `PRIVACYDW_DATA_DIR`, else next to Discord's profile (`DISCORD_USER_DATA_DIR` aware). Free-text fields (`content`, embed text, topics) may quote Discord IDs; structured fields from an instance must only carry privacy IDs. |

## Joining and the server list
- PrivacyServers patches Discord's **Join a Server** submit handler (module with `"hTKzmak"`): input
  that is an instance address or `https://<instance>/invite/<code>` link is handled by the plugin's
  join flow and never reaches Discord; bare codes and discord.gg links go to Discord as usual.
- It also patches the **Discover** button (`"guild-discover-button"`) to render a shield button right
  after it, with Discord's own list-button component, which opens the privacy-servers panel.

## Privacy media
Discord builds CDN URLs (`cdn.discordapp.com/icons/<id>/<hash>`, `/attachments/...`) itself. The
network filter redirects GET requests whose path IDs are all privacy IDs of one instance to
`<instance>/cdn/<same path>` instead of cancelling them (`mediaRedirect` in `filter.ts`); anything
else mentioning privacy IDs is still cancelled.

## Known limits of the network filter
- Gateway WebSocket frames can't be inspected by `webRequest` (only the upgrade request). Renderer
  patches must stop gateway ops (e.g. guild subscriptions) for privacy IDs from ever being sent.

## Deliberate deviations from upstream conventions
- **Authors:** our plugins use an inline `PrivacyDWAuthor` instead of a `Devs` entry in
  `src/utils/constants.ts`, because that file changes constantly upstream and would conflict on merges.
- **Vault class** (`privacyServers/vault.ts`): a class, ported from the launcher's tested vault.
