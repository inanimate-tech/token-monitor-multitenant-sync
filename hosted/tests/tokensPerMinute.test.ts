import assert from 'node:assert/strict'
import test from 'node:test'
import { accountRate, deviceRate, tokensPerMinute } from '../src/syndication/tokensPerMinute.ts'

const record = (updatedAt: string, totalTokens: number, day = '2026-10-13', syncUploadIntervalMs = 0) => ({
  updatedAt, syncUploadIntervalMs, periodWindows: { today: { key: day } }, periods: { today: { totalTokens } },
})

test('the rate is the change in today\'s tokens over the time between consecutive uploads', () => {
  assert.equal(tokensPerMinute(record('2026-10-13T10:00:00Z', 1000), record('2026-10-13T10:00:30Z', 2000)), 2000)
  assert.equal(tokensPerMinute(record('2026-10-13T10:00:00Z', 1000), record('2026-10-13T10:05:00Z', 1000)), 0)
})

test('no rate without a valid consecutive pair', () => {
  const at10 = record('2026-10-13T10:00:00Z', 1000)
  assert.equal(tokensPerMinute(null, at10), null, 'first snapshot is a baseline')
  assert.equal(tokensPerMinute(at10, record('2026-10-13T10:00:00Z', 1000)), null, 'limits-only ingest keeps updatedAt')
  assert.equal(tokensPerMinute(at10, record('2026-10-13T09:59:00Z', 2000)), null, 'out of order')
  assert.equal(tokensPerMinute(at10, record('2026-10-14T00:01:00Z', 10, '2026-10-14')), null, 'day rolled over')
  assert.equal(tokensPerMinute(at10, record('2026-10-13T10:01:00Z', 500)), null, 'counter went backwards')
  assert.equal(tokensPerMinute(at10, record('2026-10-13T12:00:00Z', 5000)), null, 'interval too long')
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
