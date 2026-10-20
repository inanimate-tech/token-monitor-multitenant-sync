// The one place tokens per minute is calculated. It runs on the stored device
// records before and after each ingest (HubDO.onIngested). Per device, the rate is
// over a sliding window of its recent readings, not between two consecutive
// uploads: tokens arrive in bursts (a turn at a time) while a widget uploads every
// few seconds, so most consecutive pairs show no change and would read as zero.
// Counted tokens are everything except cache reads, which dwarf the rest.

export type DeviceRecord = {
  updatedAt?: string
  syncUploadIntervalMs?: number
  periodWindows?: { today?: { key?: string } }
  periods?: { today?: { totalTokens?: number; cacheReadTokens?: number } }
}

// One upload's counted tokens today, and when the device read them.
export type Reading = { at: number; tokens: number; day: string | undefined }

export const WINDOW_MS = 2 * 60_000
const MAX_INTERVAL_MS = 60 * 60_000

export function reading(record: DeviceRecord): Reading | null {
  const at = Date.parse(record.updatedAt ?? '')
  if (!Number.isFinite(at)) return null
  const today = record.periods?.today
  return { at, tokens: (today?.totalTokens ?? 0) - (today?.cacheReadTokens ?? 0), day: record.periodWindows?.today?.key }
}

// The device's window after this ingest, or null when it brings no new reading (a
// limits-only ingest carries usage and its updatedAt forward; or out of order). An
// empty window (a new or restarted Hub) starts from the previous record. A new day,
// a counter that went backwards or a gap over an hour starts again from this one.
// Keeps the readings within WINDOW_MS of the latest, and the one before them, so the
// window spans the whole of it.
export function nextWindow(window: Reading[], previous: DeviceRecord | null, next: DeviceRecord): Reading[] | null {
  const now = reading(next)
  if (!now) return null
  const before = previous && reading(previous)
  const kept = window.length ? window : before ? [before] : []
  const last = kept.at(-1)
  if (last && now.at <= last.at) return null
  if (!last || last.day !== now.day || now.tokens < last.tokens || now.at - last.at > MAX_INTERVAL_MS) return [now]
  const readings = [...kept, now]
  while (readings.length > 2 && readings[1].at <= now.at - WINDOW_MS) readings.shift()
  return readings
}

// Tokens per minute across the window, or null until it has two readings.
export function windowRate(window: Reading[]): number | null {
  if (window.length < 2) return null
  const first = window[0]
  const last = window[window.length - 1]
  return Math.round(((last.tokens - first.tokens) * 60_000) / (last.at - first.at))
}

// A device's latest rate counts towards the account total until it is stale:
// twice its upload interval (as the Hub treats device freshness), at least 2 min.
const MIN_STALE_MS = 2 * 60_000

export type DeviceRate = { tokensPerMinute: number; at: number; staleAfterMs: number }

export function deviceRate(rate: number, record: DeviceRecord, at: number): DeviceRate {
  return { tokensPerMinute: rate, at, staleAfterMs: Math.max(MIN_STALE_MS, 2 * (record.syncUploadIntervalMs ?? 0)) }
}

export function accountRate(rates: Map<string, DeviceRate>, now: number) {
  const devices = [...rates]
    .filter(([, rate]) => now - rate.at < rate.staleAfterMs)
    .map(([deviceId, rate]) => ({ deviceId, tokensPerMinute: rate.tokensPerMinute }))
  return { tokensPerMinute: devices.reduce((sum, d) => sum + d.tokensPerMinute, 0), devices }
}
