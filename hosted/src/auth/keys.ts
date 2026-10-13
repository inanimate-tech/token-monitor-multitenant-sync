// Hub keys are `tmk.<accountId>.<secret>`. The account id routes the request to
// its own Account and Hub Durable Objects, so no global index is needed; only a
// SHA-256 hash of the whole key is ever stored. '.' separates because Clerk ids
// contain '_' and the base64url secret contains '_' and '-'.
const KEY_PATTERN = /^tmk\.([A-Za-z0-9_]{1,64})\.([A-Za-z0-9_-]{43})$/

export type ParsedKey = { key: string; accountId: string }

export function parseKey(key: string): ParsedKey | null {
  const match = KEY_PATTERN.exec(key)
  return match ? { key, accountId: match[1] } : null
}

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function mintKey(accountId: string): string {
  const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `tmk.${accountId}.${secret}`
}

// Same precedence as the upstream Worker: Bearer, then X-Token-Monitor-Secret,
// then ?secret= (iOS widget runtimes that cannot set headers).
export function requestKey(request: Request): string {
  const auth = request.headers.get('authorization') || ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return (request.headers.get('x-token-monitor-secret') || new URL(request.url).searchParams.get('secret') || '').trim()
}

// Per-isolate cache of verdicts, keyed by hash so no plaintext key is held.
// Rejections are cached too, so junk keys cannot hammer the Account objects.
// A revoked key therefore keeps working for up to CACHE_TTL_MS in a warm isolate.
export const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 10_000

export function createKeyResolver(
  verify: (accountId: string, hash: string) => Promise<boolean>,
  now: () => number = Date.now,
) {
  const cache = new Map<string, { ok: boolean; until: number }>()
  return async ({ key, accountId }: ParsedKey): Promise<boolean> => {
    const hash = await hashKey(key)
    const hit = cache.get(hash)
    if (hit && hit.until > now()) return hit.ok
    const ok = await verify(accountId, hash)
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear()
    cache.set(hash, { ok, until: now() + CACHE_TTL_MS })
    return ok
  }
}
