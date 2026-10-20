import assert from 'node:assert/strict'
import test from 'node:test'
import { accountRate, nextWindow, rateAt, type Reading } from '../src/syndication/tokensPerMinute.ts'

const T0 = Date.parse('2026-10-13T10:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const record = (s: number, totalTokens: number, { day = '2026-10-13', cacheReadTokens = 0, receivedS = s } = {}) => ({
  updatedAt: at(s), receivedAt: at(receivedS), periodWindows: { today: { key: day } }, periods: { today: { totalTokens, cacheReadTokens } },
})

// Feeds uploads through the window as the Hub does; the rate as of each upload.
function rates(uploads: ReturnType<typeof record>[]) {
  let window: Reading[] = []
  let previous: ReturnType<typeof record> | null = null
  return uploads.map((next) => {
    const after = nextWindow(window, previous, next)
    if (after) window = after
    previous = next
    return after ? rateAt(after, Date.parse(next.receivedAt)) : 'no reading'
  })
}

test('bursts average out over the minute instead of reading zero between them', () => {
  // Tokens arrive a turn at a time; the widget uploads every 10 s.
  assert.deepEqual(rates([record(0, 0), record(10, 1000), record(20, 1000), record(30, 1000), record(40, 2000)]), [null, 6000, 3000, 2000, 3000])
})

test('cache reads are not counted', () => {
  assert.deepEqual(rates([record(0, 10_000, { cacheReadTokens: 9000 }), record(60, 60_000, { cacheReadTokens: 58_000 })]), [null, 1000])
})

test('with no uploads at all, the rate winds down to zero within the minute', () => {
  const window = nextWindow(nextWindow([], record(0, 0), record(30, 3000))!, record(30, 3000), record(40, 4000))!
  const now = (s: number) => rateAt(window, T0 + s * 1000)
  assert.equal(now(40), 6000)
  assert.equal(now(50), 4800)
  assert.ok(now(70)! < now(50)!, 'still winding down')
  assert.equal(now(100), 0, 'a minute after the last tokens')
})

test('readings are timed by the Hub, not the device clock', () => {
  // The device's clock is an hour behind; the Hub received both 30 s apart.
  const w = nextWindow([], record(-3600, 0, { receivedS: 0 }), record(-3570, 3000, { receivedS: 30 }))!
  assert.equal(rateAt(w, T0 + 30_000), 6000)
})

test('no new reading, and starting again', () => {
  const r10 = record(0, 1000)
  assert.equal(rateAt(nextWindow([], null, r10)!, T0), null, 'first reading is a baseline')
  assert.equal(rateAt(nextWindow([], null, r10)!, T0 + 61_000), 0, 'a lone reading over a minute old reads zero')
  assert.equal(nextWindow([], r10, record(0, 1000, { receivedS: 5 })), null, 'limits-only ingest keeps updatedAt')
  assert.equal(nextWindow([], r10, record(-60, 2000)), null, 'out of order')
  assert.equal(nextWindow([], r10, record(50_000, 10, { day: '2026-10-14' }))?.length, 1, 'day rolled over')
  assert.equal(nextWindow([], r10, record(60, 500))?.length, 1, 'counter went backwards')
  assert.equal(nextWindow([], r10, record(7200, 5000))?.length, 1, 'gap over an hour')
})

test('the account rate sums devices that have uploaded in the last ten minutes', () => {
  const live = nextWindow([], record(0, 0), record(60, 1000))!
  const gone = nextWindow([], record(0, 0), record(10, 1000))!
  const windows = new Map([['live', live], ['gone', gone]])
  assert.deepEqual(accountRate(windows, T0 + 60_000), {
    tokensPerMinute: 2000,
    devices: [{ deviceId: 'live', tokensPerMinute: 1000 }, { deviceId: 'gone', tokensPerMinute: 1000 }],
  })
  assert.deepEqual(accountRate(windows, T0 + 11 * 60_000), { tokensPerMinute: 0, devices: [{ deviceId: 'live', tokensPerMinute: 0 }] })
})
