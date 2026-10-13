# Hosted multitenant Hub — design

A hosted, multitenant, sign-in-protected Token Monitor Hub on Cloudflare, deployable on any account (see `README.md`). Built as a fork-only app (`hosted/`) on top of a small, generic extension-point change to the upstream Worker hub (`worker/`).

Everything a user interacts with — the website, key handling, the tokens-per-minute calculation and anything sent to an external service — lives in this repository so it can be audited.

## Goals and non-goals

- Every signed-in user gets an isolated Hub (devices, live stream, subscriptions, sync settings) with no change to the desktop widget or headless agent: they paste a Hub URL and a key into the existing fields.
- Keys are issued, listed and revoked on a minimal website behind Clerk sign-in. No D1; key storage is Durable Object RPC.
- Optional, opt-in syndication of live tokens per minute to an external sink. hawthorn is the first sink and is named only in its sink module.
- Upstream (`Javis603/token-monitor`) receives only generic extension points; nothing hosted-, Clerk- or hawthorn-specific.
- Not in scope: web dashboards of usage, OAuth in the widget, read-only/write-only key scopes (possible follow-up).

## Architecture

```
widget / agent ──Bearer tmk.…──▶ hosted Worker (tokens.<domain>)
                                   src/server.ts front door
                                   ├─ /api/health          answered here, reveals no tenant
                                   ├─ /api/*               key ─▶ Account(userId).verify(hash) ─▶ rate limit ─▶ size limit
                                   │                        └─▶ TenantHub(userId)  (upstream HubDO subclass)
                                   │                              └─ onIngested ─▶ UsageSink (opt-in)
                                   └─ everything else      TanStack Start site (Clerk sign-in)
                                                            └─ server functions ─▶ Account(userId) RPC
```

One Worker, one host. `src/server.ts` is Wrangler's `main`: it wraps TanStack Start's server entry and exports the Durable Object classes. It imports `../worker/src/index.js` directly; the Worker-isolation rule constrains `worker/`, not its consumers, and Vite bundles the vendored CommonJS shared modules.

```
src/server.ts                  front door + Durable Object exports
src/auth/keys.ts               key format, minting, hashing, request key, cached resolver
src/account/Account.ts         key hashes and syndication opt-in (RPC)
src/account/api.ts             the website's server functions
src/hub/TenantHub.ts           upstream HubDO through its two hooks
src/routes/                    root layout (source footer) and the one account page
src/syndication/
  tokensPerMinute.ts           the only rate calculation
  sink.ts                      UsageEvent, UsageSink, selection by binding
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

Per device, over the stored records `onIngested` receives, following upstream's rule for live model rates ("consecutive per-device counter deltas; the first available snapshot establishes a baseline"):

- Same day (`periodWindows.today.key` equal): `(next − previous).periods.today.totalTokens / minutes(previous.updatedAt → next.updatedAt)`.
- No rate for a first record, a day rollover, a counter that went backwards, an interval over an hour, or a limits-only ingest (it carries `updatedAt` forward, so the interval is zero).
- The account rate sums each device's latest rate while it is fresh: twice the device's `syncUploadIntervalMs`, at least 2 minutes. Rates live in memory, so an evicted object restarts from baselines.

Resolution depends on upload cadence: the widget uploads every few seconds while active, a headless agent may upload every 20 minutes.

Open: whether `totalTokens` (cache reads dominate it) or `totalTokens − cacheReadTokens` better matches what users mean. Decide with real data.

## Syndication

- `usageSink(env)` returns the hawthorn sink when `HAWTHORN` is bound, otherwise null: a deployment without bindings sends nothing anywhere.
- Published only for accounts that opted in (default off). `UsageEvent` is the entire payload — no titles, projects, costs or records. The sink's `name` is what the opt-in shows, and the page links to `sink.ts`, `tokensPerMinute.ts` and the sink's own file at the deployed commit.
- hawthorn side (not in this repo): a `TokenMonitorUsage` `WorkerEntrypoint` with `publish(userId, event)`, forwarding to `UserAgent(idFromName(userId))`.

## Website

One page: sign in; Hub URL and setup instructions; create (shown once), list and revoke keys; the syndication opt-in with an example payload. The footer links the deployed commit. Server functions take the user only from the Clerk session; TanStack Start's default CSRF middleware covers them.

Deploys are Cloudflare Workers Builds from the public `multitenant` branch, and the footer links the commit each build came from. Build logs stay in the Cloudflare dashboard, so users cannot verify deployed bytes independently; `.github/workflows/hosted.yml` only runs the checks.

## Status

1. Upstream hooks — done, not yet offered upstream (`UPSTREAM.md`).
2. Multitenant Hub — done. Checked against `wrangler dev`: health, CORS preflight, unknown and malformed keys, two-account isolation, `?secret=`, size limit, live stream, revocation.
3. Website — done; needs Clerk keys to run.
4. Tokens per minute and sink — done. Checked end to end with a stand-in sink: no events before opt-in or for other accounts, correct per-device and summed rates.
5. hawthorn — `hawthorn.ts` done; the hawthorn-worker entrypoint is a separate change there.

## Decisions taken

- Durable Object RPC for key storage, no D1.
- `accountId` = Clerk `userId`.
- Live delta-based tokens per minute.
- One Worker serving site and Hub on one host.
- hawthorn named only in `hosted/src/syndication/hawthorn.ts`.
- Hook named `onIngested`: token-monitor names after-the-fact callbacks `on` + past tense (`onPersisted`, `onClosed`); it mirrors the agent's `onRecord`. `authorize` is a decision, so it has no prefix.
