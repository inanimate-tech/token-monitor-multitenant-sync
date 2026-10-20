import assert from 'node:assert/strict'
import test from 'node:test'
import { accountRate, deviceRate, nextWindow, windowRate, type Reading } from '../src/syndication/tokensPerMinute.ts'

const record = (updatedAt: string, totalTokens: number, day = '2026-10-13', syncUploadIntervalMs = 0, cacheReadTokens = 0) => ({
  updatedAt, syncUploadIntervalMs, periodWindows: { today: { key: day } }, periods: { today: { totalTokens, cacheReadTokens } },
})

// Feeds uploads through the window as the Hub does; the rate after each.
function rates(uploads: ReturnType<typeof record>[]) {
  let window: Reading[] = []
  let previous: ReturnType<typeof record> | null = null
  return uploads.map((next) => {
    const after = nextWindow(window, previous, next)
    if (after) window = after
    previous = next
    return after ? windowRate(after) : 'no reading'
  })
}

test('bursts average out over the window instead of reading zero between them', () => {
  // Tokens arrive a turn at a time; the widget uploads every 10 s.
  assert.deepEqual(rates([
    record('2026-10-13T10:00:00Z', 0),
    record('2026-10-13T10:00:10Z', 1000),
    record('2026-10-13T10:00:20Z', 1000),
    record('2026-10-13T10:00:30Z', 1000),
    record('2026-10-13T10:00:40Z', 2000),
  ]), [null, 6000, 3000, 2000, 3000])
})

test('cache reads are not counted', () => {
  assert.deepEqual(rates([record('2026-10-13T10:00:00Z', 10_000, undefined, 0, 9000), record('2026-10-13T10:01:00Z', 60_000, undefined, 0, 58_000)]), [null, 1000])
})

test('the window keeps two minutes, so the rate falls to zero two minutes after tokens stop', () => {
  const uploads = [record('2026-10-13T10:00:00Z', 0), record('2026-10-13T10:01:00Z', 6000)]
  for (let s = 30; s <= 180; s += 30) uploads.push(record(new Date(Date.parse('2026-10-13T10:01:00Z') + s * 1000).toISOString(), 6000))
  const out = rates(uploads)
  assert.equal(out[1], 6000)
  assert.ok((out[3] as number) > 0, 'still counts the burst within two minutes')
  assert.equal(out.at(-1), 0)
})

test('no new reading, and starting again', () => {
  const at10 = record('2026-10-13T10:00:00Z', 1000)
  assert.equal(nextWindow([], null, at10)?.length, 1, 'first reading is a baseline')
  assert.equal(windowRate(nextWindow([], null, at10)!), null)
  assert.equal(nextWindow([], at10, record('2026-10-13T10:00:00Z', 1000)), null, 'limits-only ingest keeps updatedAt')
  assert.equal(nextWindow([], at10, record('2026-10-13T09:59:00Z', 2000)), null, 'out of order')
  assert.equal(nextWindow([], at10, record('2026-10-14T00:01:00Z', 10, '2026-10-14'))?.length, 1, 'day rolled over')
  assert.equal(nextWindow([], at10, record('2026-10-13T10:01:00Z', 500))?.length, 1, 'counter went backwards')
  assert.equal(nextWindow([], at10, record('2026-10-13T12:00:00Z', 5000))?.length, 1, 'gap over an hour')
  assert.equal(windowRate(nextWindow([], at10, record('2026-10-13T10:00:30Z', 2000))!), 2000, 'an empty window starts from the previous record')
})

test('the account rate sums each device\'s latest rate until it goes stale', () => {
  const rates = new Map([
    ['live', deviceRate(100, record('', 0), 0)],
    ['agent', deviceRate(50, record('', 0, '', 20 * 60_000), 0)],
  ])
  assert.deepEqual(accountRate(rates, 60_000), {
    tokensPerMinute: 150,
    devices: [{ deviceId: 'live', tokensPerMinute: 100 }, { deviceId: 'agent', tokensPerMinute: 50 }],
  })
  assert.deepEqual(accountRate(rates, 3 * 60_000), { tokensPerMinute: 50, devices: [{ deviceId: 'agent', tokensPerMinute: 50 }] })
  assert.deepEqual(accountRate(rates, 40 * 60_000), { tokensPerMinute: 0, devices: [] })
})
