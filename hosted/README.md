# Token Monitor Hub — hosted

A multitenant [Token Monitor](https://github.com/Javis603/token-monitor) sync Hub on Cloudflare. People sign in, create a key, and point their widgets and agents at it; each account gets its own isolated Hub. Design and reasoning: [`PLAN.md`](PLAN.md).

## Deploy

You need a Cloudflare account and a [Clerk](https://clerk.com) application.

```bash
cd hosted
npm ci
# set CLERK_PUBLISHABLE_KEY in wrangler.jsonc vars
npx wrangler secret put CLERK_SECRET_KEY
npm run deploy
```

That uses Durable Objects only — no KV, D1 or other services. Add a custom domain in the Cloudflare dashboard; with a production Clerk instance, sign-in works on subdomains of the Clerk app's domain.

To deploy from CI instead, set the repository variable `HOSTED_DEPLOY=true` and the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; `.github/workflows/hosted.yml` then deploys every push to `main`.

Optional: bind a usage sink (see `src/syndication/` and the commented binding in `wrangler.jsonc`) to offer users an opt-in that sends their live tokens per minute to it. Without one, nothing is sent anywhere.

## Develop

```bash
cp .dev.vars.example .dev.vars   # add Clerk development keys
npm run dev
npm test && npm run typecheck && npm run build
```
