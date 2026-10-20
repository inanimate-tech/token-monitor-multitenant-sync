import { HubDO } from '../../../worker/src/index.js'
import { usageSink, type UsageEvent } from '../syndication/sink.ts'
import { accountRate, deviceRate, tokensPerMinute, type DeviceRate } from '../syndication/tokensPerMinute.ts'

// The upstream Hub, unchanged, one per account (named by account id).
export class TenantHub extends HubDO {
  declare state: DurableObjectState
  declare env: Env
  rates = new Map<string, DeviceRate>()
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
    return this.event(Date.now())
  }

  async onIngested({ deviceId, previous, next }: { deviceId: string; previous: object | null; next: object }) {
    const sink = usageSink(this.env)
    const accountId = this.state.id.name
    if (!sink || !accountId) return
    const rate = tokensPerMinute(previous, next)
    if (rate === null) return
    const now = Date.now()
    this.rates.set(deviceId, deviceRate(rate, next, now))
    this.subscribed ??= (await this.state.storage.get<boolean>('subscribed')) ?? false
    if (!this.subscribed) return
    // The sink answers whether anyone is still subscribed. A subscribe that
    // arrived while it answered wins.
    const subscribes = this.subscribes
    if (!(await sink.publish(accountId, this.event(now))) && subscribes === this.subscribes) {
      await this.state.storage.put('subscribed', (this.subscribed = false))
    }
  }

  private event(now: number): UsageEvent {
    return { type: 'tokens-per-minute', at: new Date(now).toISOString(), ...accountRate(this.rates, now) }
  }
}
