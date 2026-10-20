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

let clock = Date.parse('2026-10-20T10:03:00Z')

function tenantHub(storage = new Map<string, unknown>(), answers: (boolean | Promise<boolean>)[] = []) {
  const published: unknown[] = []
  const alarms: number[] = []
  const state = {
    id: { name: 'user_1' },
    storage: {
      setAlarm: async (at: number) => void alarms.push(at),
      deleteAlarm: async () => void alarms.push(-1),
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => void storage.set(key, value),
      list: async ({ prefix }: { prefix?: string } = {}) => new Map([...storage].filter(([key]) => !prefix || key.startsWith(prefix))),
    },
  }
  const HAWTHORN = { publish: async (_userId: string, event: unknown) => (published.push(event), answers.shift() ?? true) }
  const hub = new TenantHub(state as never, { HAWTHORN } as never)
  // The hub's clock: just after the latest test reading.
  hub.now = () => clock
  return { hub, published, storage, alarms }
}

test('publishes only once subscribed, and subscribing returns the rate now', async () => {
  const { hub, published } = tenantHub()
  clock = Date.parse('2026-10-20T10:01:00Z')
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

test('the last upload is the latest across devices, or null', async () => {
  const storage = new Map<string, unknown>()
  const { hub } = tenantHub(storage)
  assert.equal(await hub.lastUploadAt(), null)
  storage.set('dev:mac', { deviceId: 'mac', receivedAt: '2026-10-20T10:00:00.000Z' })
  storage.set('dev:studio', { deviceId: 'studio', receivedAt: '2026-10-20T11:00:00.000Z' })
  assert.equal(await hub.lastUploadAt(), '2026-10-20T11:00:00.000Z')
})

test('a restarted Hub carries on from the stored window', async () => {
  const storage = new Map<string, unknown>()
  const { hub } = tenantHub(storage)
  await hub.subscribe()
  clock = Date.parse('2026-10-20T10:00:30Z')
  await hub.onIngested({ deviceId: 'mac', previous: record('2026-10-20T10:00:00Z', 1000), next: record('2026-10-20T10:00:30Z', 2000) })
  const restarted = tenantHub(storage)
  clock = Date.parse('2026-10-20T10:00:45Z')
  await restarted.hub.onIngested({ deviceId: 'mac', previous: record('2026-10-20T10:00:30Z', 2000), next: record('2026-10-20T10:00:45Z', 2000) })
  // Over the stored window (10:00:00 → now, 1000 tokens in 45 s), not the one gap with no change, which reads 0.
  assert.equal((restarted.published.at(-1) as { tokensPerMinute: number }).tokensPerMinute, 1333)
})

test('with no uploads, the 10-second tick winds the rate down to zero, then stops', async () => {
  const { hub, published, alarms } = tenantHub()
  await hub.subscribe()
  clock = Date.parse('2026-10-20T10:00:30Z')
  await hub.onIngested({ deviceId: 'mac', previous: record('2026-10-20T10:00:00Z', 1000), next: record('2026-10-20T10:00:30Z', 2000) })
  assert.equal(alarms.at(-1), clock + 10_000)
  const rates: number[] = []
  for (let tick = 0; tick < 6; tick++) {
    clock = alarms.at(-1)!
    await hub.alarm()
    rates.push((published.at(-1) as { tokensPerMinute: number }).tokensPerMinute)
  }
  // 1000 tokens from 10:00:00, over the time to each tick; zero a minute after the last tokens.
  assert.deepEqual(rates, [1500, 1200, 1000, 857, 750, 0])
  assert.equal(alarms.at(-1), Date.parse('2026-10-20T10:01:30Z'), 'no tick after zero')
})
