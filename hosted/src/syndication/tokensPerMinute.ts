// The one place tokens per minute is calculated. It runs on the stored device
// records before and after each ingest (HubDO.onIngested), and follows upstream's
// rule for live rates: consecutive per-device counter deltas, where the first
// snapshot only establishes a baseline.

type DeviceRecord = {
  updatedAt?: string
  syncUploadIntervalMs?: number
  periodWindows?: { today?: { key?: string } }
  periods?: { today?: { totalTokens?: number } }
}

const MAX_INTERVAL_MS = 60 * 60_000

export function tokensPerMinute(previous: DeviceRecord | null, next: DeviceRecord): number | null {
  if (!previous) return null
  if (previous.periodWindows?.today?.key !== next.periodWindows?.today?.key) return null
  // A limits-only ingest carries usage and its updatedAt forward: no new reading.
  const ms = Date.parse(next.updatedAt ?? '') - Date.parse(previous.updatedAt ?? '')
  if (!(ms > 0) || ms > MAX_INTERVAL_MS) return null
  const delta = (next.periods?.today?.totalTokens ?? 0) - (previous.periods?.today?.totalTokens ?? 0)
  return delta >= 0 ? Math.round((delta * 60_000) / ms) : null
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
