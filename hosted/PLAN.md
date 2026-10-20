# Hosted multitenant Hub — design

A hosted, multitenant, sign-in-protected Token Monitor Hub on Cloudflare, deployable on any account (see `README.md`). Built as a fork-only app (`hosted/`) on top of a small, generic extension-point change to the upstream Worker hub (`worker/`).

Everything a user interacts with — the website, key handling, the tokens-per-minute calculation and anything sent to an external service — lives in this repository so it can be audited.

## Goals and non-goals

- Every signed-in user gets an isolated Hub (devices, live stream, subscriptions, sync settings) with no change to the desktop widget or headless agent: they paste a Hub URL and a key into the existing fields.
- Keys are issued, listed and revoked on a minimal website behind Clerk sign-in. No D1; key storage is Durable Object RPC.
- Optional syndication of live tokens per minute to an external sink, while the sink subscribes to the account. hawthorn is the first sink and is named only in its sink module.
- Upstream (`Javis603/token-monitor`) receives only generic extension points; nothing hosted-, Clerk- or hawthorn-specific.
- Not in scope: web dashboards of usage, OAuth in the widget, read-only/write-only key scopes (possible follow-up).

## Architecture

```
widget / agent ──Bearer tmk.…──▶ hosted Worker (tokens.<domain>)
                                   src/server.ts front door
                                   ├─ /api/health          answered here, reveals no tenant
                                   ├─ /api/*               key ─▶ Account(userId).verify(hash) ─▶ rate limit ─▶ size limit
                                   │                        └─▶ TenantHub(userId)  (upstream HubDO subclass)
                                   │                              └─ onIngested ─▶ UsageSink (while subscribed)
                                   └─ everything else      TanStack Start site (Clerk sign-in)
                                                            └─ server functions ─▶ Account(userId) RPC
```

One Worker, one host. `src/server.ts` is Wrangler's `main`: it wraps TanStack Start's server entry and exports the Durable Object classes. It imports `../worker/src/index.js` directly; the Worker-isolation rule constrains `worker/`, not its consumers, and Vite bundles the vendored CommonJS shared modules.

```
src/server.ts                  front door + Durable Object exports
src/auth/keys.ts               key format, minting, hashing, request key, cached resolver
src/account/Account.ts         key hashes (RPC)
src/account/api.ts             the website's server functions
src/hub/TenantHub.ts           upstream HubDO through its two hooks
src/routes/                    root layout (source footer) and the one account page
src/syndication/
  tokensPerMinute.ts           the only rate calculation
  sink.ts                      UsageEvent, UsageSink, selection by binding, Subscriptions entrypoint
  hawthorn.ts                  the only hawthorn-specific code
```

## Keys

- Format `tmk.<accountId>.<secret>`: `accountId` is the Clerk `userId`, `secret` 32 random bytes base64url. `.` separates because Clerk ids contain `_`.
  - Trade-off accepted: keys are tied to the Clerk instance; changing identity provider means re-issuing keys. In return hawthorn can address `UserAgent(userId)` with no mapping.
- `Account` (one per user, `getByName(userId)`) stores SHA-256 hashes only, with label, `createdAt`, `lastUsedAt` (hourly resolution, so verifying rarely writes). Plaintext is shown once. At most 20 keys.
- Resolution: format check → per-isolate cache keyed by hash (accepts and rejections, 60 s) → `Account.verify`. A revoked key can keep working for up to a minute; the page says so.
- Per-account rate limit (Workers rate-limit binding) and the Node Hub's 1 MiB body ceiling, both at the front door.
- `?secret=` stays accepted for iOS widget runtimes (upstream behaviour); the page suggests a separate key for that use because URLs can be logged.

## Upstream extension points

`HubDO.authorize(request)` and `HubDO.onIngested({ deviceId, previous, next })`; see `UPSTREAM.md` and `docs/architecture.md` (Entry points). `TenantHub` overrides `authorize` to trust the front door and `onIngested` to compute tokens per minute.

Until upstream registers a build containing the hooks, `/api/health` reports `hubBuild: null`, so widgets show the build as unknown rather than claiming a registered build.

## Tokens per minute

A live rate, not the widget's active-time average (`tokenBurnPerMinute` in `src/electron/renderer/tokenRatePresentation.js` is `timedTokens / timedDurationMs`); the page says the two differ.

Per device, the counted tokens it used over the minute ending now:

- Counted tokens are `totalTokens − cacheReadTokens`. Live data showed cache reads dominate the total (about a million a minute while working), which isn't what people mean.
- Each device keeps a window of readings (when the Hub received the upload, by its own clock; when the device read it; counted tokens today): those within a minute of the latest, and the one before them. The rate is the increase from the last reading at or before a minute ago (or the window's first) to the latest, over the time from that reading to now. Not consecutive uploads: tokens arrive a turn at a time while the widget uploads every 7–20 s, so most consecutive pairs showed no change and published zero between bursts (seen in the live logs, October 2026).
- Measured to now, not to the latest upload, so it winds down even when uploads stop. While the account's rate is above zero, an alarm publishes it every 10 s; it reaches zero a minute after the last tokens, is published once more, and the alarm stops. Each publish puts the next tick off, so an active widget's uploads publish and the tick only fills gaps.
- No new reading for a limits-only ingest (it carries `updatedAt` forward) or one out of order, so nothing is published. A new day, a counter that went backwards or a gap over an hour starts the window again; a lone reading is only a baseline. Windows are stored, because the live Hub was seen restarting every minute or so.
- The account rate sums the devices that have uploaded in the last ten minutes. A headless agent uploading every 20 minutes shows its last interval's rate for a minute after each upload.

## Syndication

- `usageSink(env)` returns the hawthorn sink when `HAWTHORN` is bound, otherwise null: a deployment without bindings sends nothing anywhere.
- Publish and subscribe. The sink subscribes to an account through the `Subscriptions` entrypoint (`subscribe(accountId)`, which returns the current event); `TenantHub` keeps a stored `subscribed` flag and publishes on each ingest only while it is set. `publish` answers whether the account still has a subscriber; `false` clears the flag until the sink subscribes again, so there is no unsubscribe call, and a subscribe that arrives while a publish is answering wins. The entrypoint offers only `subscribe`, so a bound sink never reaches a Hub's data routes.
- Consent is the sink's: hawthorn subscribes when the user has a device using it. There is no opt-in here; the page says what is sent and when. `UsageEvent` is the entire payload — no titles, projects, costs or records. The page names the sink and links to `sink.ts`, `tokensPerMinute.ts` and the sink's own file at the deployed commit.
- Throttling what devices receive, and showing zero once uploads stop, are the sink's: the sink sees every event and knows its subscribers. This Worker stays a flag and a call.
- hawthorn side (not in this repo): a `TokenMonitorUsage` `WorkerEntrypoint` with `publish(userId, event): boolean`, forwarding to `UserAgent(userId)`, and a binding to `Subscriptions`.

## Website

One page: sign in; Hub URL and setup instructions; create (shown once), list and revoke keys; what a subscribed sink receives, with an example payload. The footer links the deployed commit. Server functions take the user only from the Clerk session; TanStack Start's default CSRF middleware covers them.

Deploys are Cloudflare Workers Builds from the public `multitenant` branch, and the footer links the commit each build came from. Build logs stay in the Cloudflare dashboard, so users cannot verify deployed bytes independently; `.github/workflows/hosted.yml` only runs the checks.

## Status

1. Upstream hooks — done, not yet offered upstream (`UPSTREAM.md`).
2. Multitenant Hub — done. Checked against `wrangler dev`: health, CORS preflight, unknown and malformed keys, two-account isolation, `?secret=`, size limit, live stream, revocation.
3. Website — done; needs Clerk keys to run.
4. Tokens per minute and sink — done; publish and subscribe in `tests/tenantHub.test.ts`, and `Subscriptions` → `TenantHub.subscribe()` checked over a real service binding in `wrangler dev`.
5. hawthorn — `hawthorn.ts` done; the hawthorn-worker entrypoint is a separate change there.

## Decisions taken

- Durable Object RPC for key storage, no D1.
- `accountId` = Clerk `userId`.
- Live delta-based tokens per minute.
- Publish while a sink subscribes, rather than a per-account opt-in; `HubDO` extends `DurableObject` (`UPSTREAM.md`) so `TenantHub` takes RPC.
- One Worker serving site and Hub on one host.
- hawthorn named only in `hosted/src/syndication/hawthorn.ts`.
- Hook named `onIngested`: token-monitor names after-the-fact callbacks `on` + past tense (`onPersisted`, `onClosed`); it mirrors the agent's `onRecord`. `authorize` is a decision, so it has no prefix.
