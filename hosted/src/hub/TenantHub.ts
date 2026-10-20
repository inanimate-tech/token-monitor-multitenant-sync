import { HubDO } from '../../../worker/src/index.js'
import { usageSink, type UsageEvent } from '../syndication/sink.ts'
import { accountRate, nextWindow, type DeviceRecord, type Reading } from '../syndication/tokensPerMinute.ts'

// Debugging the live rate: one JSON line per step, read with `wrangler tail` or Workers Logs.
const log = (step: string, data: object) => console.log(JSON.stringify({ tm: step, ...data }))

// While the rate is above zero, it is published again this often, so it winds down
// to zero even when no upload arrives.
const TICK_MS = 10_000

// The upstream Hub, unchanged, one per account (named by account id).
export class TenantHub extends HubDO {
  declare state: DurableObjectState
  declare env: Env
  // Each device's recent readings, kept in storage too: live logs showed the Hub
  // restarting every minute or so. Loaded from storage once per instance.
  windows?: Map<string, Reading[]>
  subscribed?: boolean
  subscribes = 0
  now = () => Date.now()

  // The front door (server.ts) authenticates every request before forwarding it,
  // and a Durable Object is reachable only through the Worker that binds it.
  async authorize(_request: Request) {
    return null
  }

  // The sink has a subscriber for this account (via Subscriptions, sink.ts).
  async subscribe(): Promise<UsageEvent> {
    this.subscribes++
    await this.state.storage.put('subscribed', (this.subscribed = true))
    const event = await this.event(this.now())
    if (event.tokensPerMinute > 0) await this.state.storage.setAlarm(this.now() + TICK_MS)
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
    const windows = await this.loadWindows()
    const window = nextWindow(windows.get(deviceId) ?? [], previous, next)
    log('ingested', {
      account: this.state.id.name,
      deviceId,
      previousAt: previous?.updatedAt ?? null,
      nextAt: next.updatedAt ?? null,
      receivedAt: next.receivedAt ?? null,
      newReading: !!window,
      window: window && { readings: window.length, spanMs: window.at(-1)!.at - window[0].at, tokens: window.at(-1)!.tokens - window[0].tokens },
    })
    if (!window) return
    windows.set(deviceId, window)
    await this.state.storage.put(`window:${deviceId}`, window)
    await this.publish('ingest')
  }

  // The 10-second clock: publish the rate as of now while it is above zero.
  async alarm() {
    await this.publish('tick')
  }

  private async loadWindows(): Promise<Map<string, Reading[]>> {
    if (!this.windows) {
      const stored = await this.state.storage.list<Reading[]>({ prefix: 'window:' })
      this.windows = new Map([...stored].map(([key, window]) => [key.slice('window:'.length), window]))
      log('restarted', { account: this.state.id.name, windows: this.windows.size })
    }
    return this.windows
  }

  private async event(now: number): Promise<UsageEvent> {
    return { type: 'tokens-per-minute', at: new Date(now).toISOString(), ...accountRate(await this.loadWindows(), now) }
  }

  private async publish(why: 'ingest' | 'tick') {
    const sink = usageSink(this.env)
    const accountId = this.state.id.name
    if (!sink || !accountId) return
    this.subscribed ??= (await this.state.storage.get<boolean>('subscribed')) ?? false
    if (!this.subscribed) {
      log('not-subscribed', { account: accountId, why })
      return
    }
    const event = await this.event(this.now())
    // Keep ticking while there is a rate to wind down; each publish puts the tick off.
    if (event.tokensPerMinute > 0) await this.state.storage.setAlarm(this.now() + TICK_MS)
    // The sink answers whether anyone is still subscribed. A subscribe that
    // arrived while it answered wins.
    const subscribes = this.subscribes
    const t0 = Date.now()
    let listening: boolean
    try {
      listening = await sink.publish(accountId, event)
    } catch (error) {
      log('publish-failed', { account: accountId, why, event, error: String(error), ms: Date.now() - t0 })
      throw error
    }
    log('published', { account: accountId, why, event, listening, ms: Date.now() - t0 })
    if (!listening && subscribes === this.subscribes) {
      await this.state.storage.put('subscribed', (this.subscribed = false))
      await this.state.storage.deleteAlarm()
      log('unsubscribed', { account: accountId })
    }
  }
}
