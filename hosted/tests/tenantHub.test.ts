import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Plain Node has no cloudflare:workers; stand in for the two base classes used.
const stub = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } } export class WorkerEntrypoint {}'
registerHooks({ resolve: (specifier, context, next) => (specifier === 'cloudflare:workers' ? { url: stub, shortCircuit: true } : next(specifier, context)) })
const { TenantHub } = await import('../src/hub/TenantHub.ts')

const record = (updatedAt: string, totalTokens: number) => ({ updatedAt, periodWindows: { today: { key: '2026-10-20' } }, periods: { today: { totalTokens } } })
const ingest = (minute: number, totalTokens: number) => ({
  deviceId: 'mac',
  previous: record(`2026-10-20T10:0${minute - 1}:00Z`, totalTokens - 1000),
  next: record(`2026-10-20T10:0${minute}:00Z`, totalTokens),
})

function tenantHub(storage = new Map<string, unknown>(), answers: (boolean | Promise<boolean>)[] = []) {
  const published: unknown[] = []
  const state = {
    id: { name: 'user_1' },
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => void storage.set(key, value),
      list: async () => new Map(),
    },
  }
  const HAWTHORN = { publish: async (_userId: string, event: unknown) => (published.push(event), answers.shift() ?? true) }
  return { hub: new TenantHub(state as never, { HAWTHORN } as never), published, storage }
}

test('publishes only once subscribed, and subscribing returns the rate now', async () => {
  const { hub, published } = tenantHub()
  await hub.onIngested(ingest(1, 2000))
  assert.equal(published.length, 0)
  assert.equal((await hub.subscribe()).tokensPerMinute, 1000)
  await hub.onIngested(ingest(2, 3000))
  assert.equal(published.length, 1)
})

test('stops when the sink answers that no one is subscribed, and stays subscribed across restarts', async () => {
  const { hub, storage } = tenantHub()
  await hub.subscribe()
  const restarted = tenantHub(storage, [false])
  await restarted.hub.onIngested(ingest(1, 2000))
  await restarted.hub.onIngested(ingest(2, 3000))
  assert.equal(restarted.published.length, 1)
  assert.equal(storage.get('subscribed'), false)
})

test('a subscribe that arrives while the sink answers no wins', async () => {
  let answer!: (subscribed: boolean) => void
  const { hub, storage } = tenantHub(undefined, [new Promise((resolve) => (answer = resolve))])
  await hub.subscribe()
  const publishing = hub.onIngested(ingest(1, 2000))
  await new Promise((resolve) => setImmediate(resolve))
  await hub.subscribe()
  answer(false)
  await publishing
  assert.equal(storage.get('subscribed'), true)
})
