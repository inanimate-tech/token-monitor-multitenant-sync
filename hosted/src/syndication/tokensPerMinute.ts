// The one place tokens per minute is calculated. Each device's readings come from
// the stored records before and after each ingest (HubDO.onIngested); its rate is
// the counted tokens it used over the minute ending now. Not between two
// consecutive uploads: tokens arrive in bursts (a turn at a time) while a widget
// uploads every few seconds, so most consecutive pairs show no change and would
// read as zero. Measured to now, not to the last upload, so it winds down to zero
// within a minute of the last tokens even when uploads stop.
// Counted tokens are everything except cache reads, which dwarf the rest.

export type DeviceRecord = {
  updatedAt?: string
  receivedAt?: string
  periodWindows?: { today?: { key?: string } }
  periods?: { today?: { totalTokens?: number; cacheReadTokens?: number } }
}

// One upload: when the Hub received it (`at`, the Hub's clock, so it compares with
// now), when the device read it (`read`, which a limits-only ingest carries
// forward), and its counted tokens today.
export type Reading = { at: number; read: number; tokens: number; day: string | undefined }

export const WINDOW_MS = 60_000
const MAX_INTERVAL_MS = 60 * 60_000
// A device that hasn't uploaded for this long drops out of the account's devices.
const DEVICE_GONE_MS = 10 * 60_000

export function reading(record: DeviceRecord): Reading | null {
  const read = Date.parse(record.updatedAt ?? '')
  if (!Number.isFinite(read)) return null
  const received = Date.parse(record.receivedAt ?? '')
  const today = record.periods?.today
  return {
    at: Number.isFinite(received) ? received : read,
    read,
    tokens: (today?.totalTokens ?? 0) - (today?.cacheReadTokens ?? 0),
    day: record.periodWindows?.today?.key,
  }
}

// The device's window after this ingest, or null when it brings no new reading (a
// limits-only ingest, or one out of order). An empty window (a new Hub) starts from
// the previous record. A new day, a counter that went backwards or a gap over an
// hour starts again from this one. Keeps the readings within WINDOW_MS of the
// latest, and the one before them.
export function nextWindow(window: Reading[], previous: DeviceRecord | null, next: DeviceRecord): Reading[] | null {
  const now = reading(next)
  if (!now) return null
  const before = previous && reading(previous)
  const kept = window.length ? window : before ? [before] : []
  const last = kept.at(-1)
  if (last && now.read <= last.read) return null
  if (!last || last.day !== now.day || now.tokens < last.tokens || now.at - last.at > MAX_INTERVAL_MS) return [now]
  const readings = [...kept, now]
  while (readings.length > 2 && readings[1].at <= now.at - WINDOW_MS) readings.shift()
  return readings
}

// Tokens per minute over the minute ending `now`: from the last reading at or before
// its start (or the first, in a younger window) to the latest, over the time to now.
// Null for a lone reading inside the minute: it is only a baseline.
export function rateAt(window: Reading[], now: number): number | null {
  const last = window.at(-1)
  if (!last) return null
  const start = [...window].reverse().find((r) => r.at <= now - WINDOW_MS) ?? window[0]
  if (start === last) return last.at <= now - WINDOW_MS ? 0 : null
  return Math.max(0, Math.round(((last.tokens - start.tokens) * 60_000) / Math.max(now - start.at, 1)))
}

// The account's rate now: each device that has uploaded lately, summed.
export function accountRate(windows: Map<string, Reading[]>, now: number) {
  const devices = [...windows].flatMap(([deviceId, window]) => {
    const rate = rateAt(window, now)
    return rate === null || now - window.at(-1)!.at > DEVICE_GONE_MS ? [] : [{ deviceId, tokensPerMinute: rate }]
  })
  return { tokensPerMinute: devices.reduce((sum, d) => sum + d.tokensPerMinute, 0), devices }
}
