import { HubDO } from '../../../worker/src/index.js'
import { usageSink, type UsageEvent } from '../syndication/sink.ts'
import { accountRate, deviceRate, nextWindow, windowRate, type DeviceRate, type DeviceRecord, type Reading } from '../syndication/tokensPerMinute.ts'

// Debugging the live rate: one JSON line per step, read with `wrangler tail` or Workers Logs.
const log = (step: string, data: object) => console.log(JSON.stringify({ tm: step, ...data }))

// The upstream Hub, unchanged, one per account (named by account id).
export class TenantHub extends HubDO {
  declare state: DurableObjectState
  declare env: Env
  rates = new Map<string, DeviceRate>()
  // Each device's recent readings; in memory, so an evicted Hub starts again from the previous record.
  windows = new Map<string, Reading[]>()
  subscribed?: boolean
  subscribes = 0

  // The front door (server.ts) authenticates every request before forwarding it,
  // and a Durable Object is reachable only through the Worker that binds it.
  async authorize(_request: Request) {
    return null
  }

  // The sink has a subscriber for this account (via Subscriptions, sink.ts).
  async subscribe(): Promise<UsageEvent> {
    this.subscribes++
    await this.state.storage.put('subscribed', (this.subscribed = true))
    const event = this.event(Date.now())
    log('subscribe', { account: this.state.id.name, event })
    return event
  }

  // When a device last uploaded, or null: for the sink's status check, which doesn't subscribe.
  async lastUploadAt(): Promise<string | null> {
    const devices: { receivedAt?: string }[] = await this.listDevices()
    const last = devices.flatMap((d) => (d.receivedAt ? [d.receivedAt] : [])).sort().at(-1) ?? null
    log('status', { account: this.state.id.name, devices: devices.length, lastUploadAt: last })
    return last
  }

  async onIngested({ deviceId, previous, next }: { deviceId: string; previous: DeviceRecord | null; next: DeviceRecord }) {
    const sink = usageSink(this.env)
    const accountId = this.state.id.name
    const window = nextWindow(this.windows.get(deviceId) ?? [], previous, next)
    if (window) this.windows.set(deviceId, window)
    const rate = window ? windowRate(window) : null
    log('ingested', {
      account: accountId,
      deviceId,
      sink: sink?.name ?? null,
      previousAt: previous?.updatedAt ?? null,
      nextAt: next.updatedAt ?? null,
      newReading: !!window,
      window: window && { readings: window.length, spanMs: window.at(-1)!.at - window[0].at, tokens: window.at(-1)!.tokens - window[0].tokens },
      day: next.periodWindows?.today?.key ?? null,
      uploadIntervalMs: next.syncUploadIntervalMs ?? null,
      rate,
      ratesHeld: this.rates.size,
    })
    if (!sink || !accountId) return
    if (rate === null) return
    const now = Date.now()
    this.rates.set(deviceId, deviceRate(rate, next, now))
    this.subscribed ??= (await this.state.storage.get<boolean>('subscribed')) ?? false
    if (!this.subscribed) {
      log('not-subscribed', { account: accountId })
      return
    }
    // The sink answers whether anyone is still subscribed. A subscribe that
    // arrived while it answered wins.
    const subscribes = this.subscribes
    const event = this.event(now)
    const t0 = Date.now()
    let listening: boolean
    try {
      listening = await sink.publish(accountId, event)
    } catch (error) {
      log('publish-failed', { account: accountId, event, error: String(error), ms: Date.now() - t0 })
      throw error
    }
    log('published', { account: accountId, event, listening, ms: Date.now() - t0 })
    if (!listening && subscribes === this.subscribes) {
      await this.state.storage.put('subscribed', (this.subscribed = false))
      log('unsubscribed', { account: accountId })
    }
  }

  private event(now: number): UsageEvent {
    return { type: 'tokens-per-minute', at: new Date(now).toISOString(), ...accountRate(this.rates, now) }
  }
}
