# Hosted multitenant Hub — plan

A hosted, multitenant, sign-in-protected Token Monitor Hub on Cloudflare, deployable on any account with one `wrangler deploy`. Built as a fork-only app (`hosted/`) on top of a small, generic extension-point change to the upstream Worker hub (`worker/`).

Everything a user interacts with — the website, key handling, the tokens-per-minute calculation and anything sent to an external service — lives in this repository so it can be audited.

## Goals and non-goals

- Every signed-in user gets an isolated Hub (devices, live stream, subscriptions, sync settings) with no change to the desktop widget or headless agent: they paste a Hub URL and a key into the existing fields.
- Keys are issued, listed and revoked on a minimal website behind Clerk sign-in. No D1; key storage is Durable Object RPC.
- Optional, opt-in syndication of live tokens per minute to an external sink. hawthorn is the first sink and the only place it is named.
- Upstream (`Javis603/token-monitor`) receives only generic extension points; nothing hosted-, Clerk- or hawthorn-specific.
- Not in scope: web dashboards of usage, OAuth in the widget, read-only/write-only key scopes (possible follow-up).

## Architecture

```
widget / agent ──Bearer tmk_…──▶ hosted Worker (tokens.<domain>)
                                   server.ts front door
                                   ├─ /api/health          answered here, reveals no tenant
                                   ├─ /api/*               resolve key ─▶ AccountDO(userId).verify(hash)
                                   │                        └─▶ TenantHubDO(userId)  (upstream HubDO subclass)
                                   │                              └─ onIngested ─▶ UsageSink (opt-in)
                                   └─ everything else      TanStack Start site (Clerk sign-in)
                                                            └─ server fns ─▶ AccountDO(userId) RPC
```

One Worker, one host. TanStack Start's custom `src/server.ts` entry exports the Durable Object classes and is Wrangler's `main`.

### Layout

```
hosted/
  PLAN.md                    this file
  package.json               own deps; nothing added to the repo root
  wrangler.jsonc             HUB → TenantHubDO, ACCOUNTS → AccountDO, optional HAWTHORN service binding
  src/server.ts              front door + DO exports
  src/auth/keys.ts           key format, generation, hashing, in-memory resolve cache
  src/account/AccountDO.ts   key hashes, labels, created/lastUsed, syndication opt-in
  src/hub/TenantHubDO.ts     extends upstream HubDO via its two hooks
  src/routes/                sign in · keys · syndication · "what is sent"
  src/syndication/
    tokensPerMinute.ts       pure, tested; the only rate calculation
    sink.ts                  UsageSink interface, NullSink, selection by binding
    hawthorn.ts              the only file that mentions hawthorn
  tests/
```

`hosted/` imports `../worker/src/index.js` directly; the Worker-isolation rule constrains `worker/`, not its consumers. The vendored `worker/src/shared/` modules are CommonJS and are bundled by Vite.

## Keys

- Format: `tmk_<accountId>_<secret>`, `secret` = 32 random bytes base64url. `accountId` = Clerk `userId`.
  - Trade-off accepted: keys are tied to the Clerk instance; changing identity provider means re-issuing keys. In return hawthorn can address `UserAgent(userId)` with no mapping.
- `AccountDO` (one per user, `idFromName(userId)`) stores SHA-256 hashes only, with label, `createdAt`, `lastUsedAt` (coarsened to avoid a write per ingest). Plaintext is shown once at creation.
- RPC surface: `verify(hash) → boolean`, `listKeys()`, `createKey(label) → plaintext`, `revokeKey(keyId)`, `getSyndication()`, `setSyndication(enabled)`.
- Front-door resolution: format check → per-isolate cache keyed by hash (positive and negative, ~60 s TTL) → `AccountDO.verify`. Revocation therefore takes effect within the TTL; the keys page says so.
- Per-key rate limiting with the Workers rate-limit binding; reject oversized ingest bodies at the front door.
- `?secret=` stays accepted for iOS widget runtimes (upstream behaviour). The keys page warns that a key in a URL may be logged and suggests a dedicated, separately revocable key for that use.

## Upstream PR: "extension points for embedding the Worker hub"

Generic, roughly 30 lines in `worker/src/index.js`, default behaviour unchanged:

1. `HubDO.authorize(request)` — the existing secret gate (including the 503 when `TOKEN_MONITOR_SECRET` is unset) moved into an overridable method.
2. `HubDO.onIngested({ deviceId, previous, next })` — no-op by default; receives the stored device records before and after the merge, not the raw upload. Called after `mutate()` resolves and never awaited, so it never runs inside `blockConcurrencyWhile`; errors are logged and swallowed. Records are passed through `stripSessionTextFromDeviceRecord` first so no subclass can leak session titles.
3. Tests for both hooks; `docs/architecture.md` (Entry points) describes embedding; `npm run update:hub-build`.

Done: see `hosted/UPSTREAM.md` for the commit and draft PR.

The hosted app needs nothing else from upstream. If upstream declines, the fork carries the same patch.

Known effect: until upstream registers a build containing the hooks, released widgets report the hosted Hub's build as `unknown`. The front door's `/api/health` must report an honest build identity, never a registered one it is not running.

## Tokens per minute

Live rate, not the widget's active-time average (`tokenBurnPerMinute` in `src/electron/renderer/tokenRatePresentation.js` is `timedTokens / timedDurationMs` over the period, so the two numbers will differ; the "what is sent" page explains this).

`tokensPerMinute(previous, next)` per device, over the stored records `onIngested` receives:

- Follows upstream's rule for live model rates (`docs/API.md`: "consecutive per-device counter deltas; the first available snapshot establishes a baseline"), so the hosted rate and the widget's live model rates agree on what a delta is.
- Same day (`periodWindows.today.key` equal): `max(0, next.periods.today.totalTokens − previous.periods.today.totalTokens) / minutes(previous.updatedAt → next.updatedAt)`.
- Limits-only ingests carry usage and its `updatedAt` forward unchanged: skip them (equal `updatedAt`), never emit 0 or divide by zero.
- Day rolled over, first record (`previous` null), or non-positive/implausible interval: emit no rate for that ingest.
- The account-level figure is the sum over devices of each device's latest rate, decayed to 0 once a device's last ingest is older than its `syncUploadIntervalMs` window.

Resolution depends on upload cadence: the widget's watch path uploads every few seconds while active, but a headless agent may upload every 20 minutes, giving a coarse average.

Open: whether `totalTokens` (which includes cache reads and dominates in practice) or `totalTokens − cacheReadTokens` better matches what a user means by "tokens per minute". Decide with real data before M4.

## Syndication sink

```ts
interface UsageSink { publish(accountId: string, event: UsageEvent): Promise<void> }
type UsageEvent = { type: 'tokens-per-minute', at: string, tokensPerMinute: number, devices: { deviceId: string, tokensPerMinute: number }[] }
```

- Selected in `sink.ts`: `HawthornSink` if `env.HAWTHORN` is bound, otherwise `NullSink`. Deployments without the binding are a plain hosted multitenant Hub.
- Sent only when the account has opted in (default off). The event above is the entire payload — no titles, projects, costs or raw records — and the "what is sent" page renders a live example and links to `tokensPerMinute.ts` and `hawthorn.ts`.
- `TenantHubDO.onIngested` computes the event and publishes it; the hook is never awaited, so a failing sink never affects ingest.

hawthorn side (not in this repo): a `WorkerEntrypoint` (e.g. `TokenMonitorUsage.publish(userId, event)`) that forwards to `UserAgent(idFromName(userId))`. Interface only is specified here.

## Website (TanStack Start + `@clerk/tanstack-react-start`)

Deliberately minimal:

- **Sign in** — Clerk; same instance as hawthorn. Production Clerk shares sessions across subdomains of one root domain; a different root needs Clerk satellite domains.
- **Keys** — Hub URL with copy button, create (label) → show once, list (label, created, last used), revoke. Setup snippets for widget and `.env`.
- **Syndication** — opt-in toggle, live example payload, links to the code.
- **Footer** — deployed commit SHA linking to the fork tree. Deploy only from GitHub Actions on the public fork so the build log is public; state plainly that users cannot otherwise verify deployed bytes.

Security: server functions derive `userId` from the Clerk session only, never from input; CSRF protection on mutations; strict CORS on site routes (Hub `/api/*` keeps upstream `*`, since it is bearer-only).

## Deploying elsewhere

```bash
cd hosted
npm install
npx wrangler secret put CLERK_SECRET_KEY
# set CLERK_PUBLISHABLE_KEY in wrangler.jsonc vars
npx wrangler deploy
```

No KV, D1 or external services; Durable Objects only. The `HAWTHORN` binding is optional.

## Dependencies (scoped to `hosted/package.json`)

TanStack Start, `@clerk/tanstack-react-start`, `@cloudflare/vite-plugin`, Wrangler. Root `npm run verify`, CI and the Deploy-to-Cloudflare button for `worker/` are unaffected. A separate CI job runs `hosted/` lint, tests and build.

## Milestones

1. **Upstream hooks** — `authorize` + `onIngested` in `worker/`, tests, docs, hub build marker. Open as the upstream PR.
2. **Multitenant Hub without a website** — `hosted/` scaffold, `server.ts` front door, `TenantHubDO`, `AccountDO`, key resolution and cache, health; keys seeded via a dev-only script. Verify with the real widget and `npm run agent:once` against `wrangler dev`, including tenant isolation and revocation.
3. **Website** — Clerk sign-in, keys page, footer SHA, CI deploy.
4. **Tokens per minute + sink** — `tokensPerMinute.ts` with tests, `NullSink`, opt-in, "what is sent" page.
5. **hawthorn sink** — `hawthorn.ts` + the hawthorn-worker entrypoint (separate PR there).

## Decisions taken

- Durable Object RPC for key storage, no D1.
- `accountId` = Clerk `userId`.
- Live delta-based tokens per minute.
- One Worker serving site and Hub on one host.
- hawthorn named only in `hosted/src/syndication/hawthorn.ts`.
- Hook named `onIngested`: token-monitor names after-the-fact callbacks `on` + past tense (`onPersisted`, `onClosed`); it mirrors the agent's `onRecord`. `authorize` is a decision, so it has no prefix.
