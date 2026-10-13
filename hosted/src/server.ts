import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { env } from 'cloudflare:workers'
import upstream from '../../worker/src/index.js'
import { createKeyResolver, parseKey, requestKey } from './auth/keys.ts'

export { Account } from './account/Account.ts'
export { TenantHub } from './hub/TenantHub.ts'

// The front door. /api/* is the Token Monitor Hub API, served per account by
// TenantHub once the key is verified; everything else is the website.
const MAX_BODY_BYTES = 1024 * 1024 // the Node Hub's ingest ceiling

const resolveKey = createKeyResolver((accountId, hash) => env.ACCOUNTS.getByName(accountId).verify(hash))

const json = (status: number, body: object) =>
  Response.json(body, { status, headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } })

async function hub(request: Request): Promise<Response> {
  // Upstream answers CORS preflight before touching any binding.
  if (request.method === 'OPTIONS') return upstream.fetch(request, env)
  // Answered here: without a key there is no tenant, and health must not reveal
  // one. hubBuild is null because this is not a registered upstream build.
  if (new URL(request.url).pathname === '/api/health') {
    return json(200, { ok: true, role: 'hub', runtime: 'cloudflare-worker', version: 1, hubBuild: null, secretRequired: true, now: new Date().toISOString() })
  }
  const key = parseKey(requestKey(request))
  if (!key || !(await resolveKey(key))) return json(401, { error: 'unauthorized' })
  if (!(await env.HUB_LIMITER.limit({ key: key.accountId })).success) return json(429, { error: 'rate_limited' })
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return json(413, { error: 'payload_too_large' })
  return env.HUB.getByName(key.accountId).fetch(request)
}

export default createServerEntry({
  fetch: (request) => (new URL(request.url).pathname.startsWith('/api/') ? hub(request) : handler.fetch(request)),
})
