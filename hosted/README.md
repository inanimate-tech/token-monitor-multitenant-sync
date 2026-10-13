# Token Monitor Hub — hosted

A multitenant [Token Monitor](https://github.com/Javis603/token-monitor) sync Hub on Cloudflare. People sign in, create a key, and point their widgets and agents at it; each account gets its own isolated Hub. Design and reasoning: [`PLAN.md`](PLAN.md).

## Deploy

You need a Cloudflare account and a [Clerk](https://clerk.com) application. Put its publishable key in `CLERK_PUBLISHABLE_KEY` under `vars` in `wrangler.jsonc`, then either:

- **Build on push** (Cloudflare dashboard → Workers → Create → Import a repository), with:
  - Production branch: `multitenant`
  - Root directory: `hosted`
  - Build command: `npm run build`; deploy command: `npx wrangler deploy`
  - Build watch paths: `hosted/*` and `worker/*` (the Hub code is bundled from `worker/`)
  - The Worker name must match `name` in `wrangler.jsonc`.

  Then add `CLERK_SECRET_KEY` as a secret under the Worker's Settings → Variables and Secrets.
- **Deploy by hand**: `cd hosted && npm ci && npx wrangler secret put CLERK_SECRET_KEY && npm run deploy`.

It uses Durable Objects only — no KV, D1 or other services. Add a custom domain in the dashboard; with a production Clerk instance, sign-in works on subdomains of the Clerk app's domain. The footer links the deployed commit (`WORKERS_CI_COMMIT_SHA` on Workers Builds, the local checkout otherwise), so deploy from pushed commits.

Optional: bind a usage sink (see `src/syndication/` and the commented binding in `wrangler.jsonc`) to offer users an opt-in that sends their live tokens per minute to it. Without one, nothing is sent anywhere.

## Develop

```bash
cp .dev.vars.example .dev.vars   # add Clerk development keys
npm run dev
npm test && npm run typecheck && npm run build
```
