# Upstream candidates

Changes in this fork that are generic enough to offer to `Javis603/token-monitor`. Each is a self-contained commit touching only upstream files, so it can be cherry-picked onto a branch from `upstream/main`.

Before opening a PR: cherry-pick onto current upstream, re-run `npm run update:hub-build` (the registry revision will have moved), and `npm run verify`.

## Worker extension points

Commit: `feat(worker): add authorize and onIngested extension points`

Draft PR title: `feat(worker): add authorize and onIngested extension points`

Draft PR body:

> Adds two extension points to the Cloudflare Worker's `HubDO` so another Worker can embed it — for example a multitenant front door that authenticates requests itself and routes each tenant to `idFromName(tenant)` — without forking the Hub.
>
> - `authorize(request)` — the existing secret gate (503 without `TOKEN_MONITOR_SECRET`, 401 on mismatch) moved into an overridable method. Health and `/api/public/stats` are still served before it. Default behaviour is unchanged.
> - `onIngested({ deviceId, previous, next })` — a no-op hook called after each stored ingest. It runs after the mutation lane resolves and is never awaited, so an observer cannot delay the ingest response or reset the Durable Object by throwing. Both records have session text stripped regardless of title policy, so an observer cannot leak titles.
>
> No wire, endpoint, settings or env changes. `docs/architecture.md` (Entry points) documents both. The Worker adapter's Hub build revision moves.
>
> Tests: `tests/worker/extensionPoints.test.js` (subclass gate, previous/next pairs, refused ingests not observed, failing observer isolated, session text stripped). `npm run verify`.
