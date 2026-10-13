import { HubDO } from '../../../worker/src/index.js'
import { usageSink } from '../syndication/sink.ts'
import { accountRate, deviceRate, tokensPerMinute, type DeviceRate } from '../syndication/tokensPerMinute.ts'

// The upstream Hub, unchanged, one per account (named by account id).
export class TenantHub extends HubDO {
  declare state: DurableObjectState
  declare env: Env
  rates = new Map<string, DeviceRate>()

  // The front door (server.ts) authenticates every request before forwarding it,
  // and a Durable Object is reachable only through the Worker that binds it.
  async authorize(_request: Request) {
    return null
  }

  async onIngested({ deviceId, previous, next }: { deviceId: string; previous: object | null; next: object }) {
    const sink = usageSink(this.env)
    const accountId = this.state.id.name
    if (!sink || !accountId) return
    const rate = tokensPerMinute(previous, next)
    if (rate === null) return
    const now = Date.now()
    this.rates.set(deviceId, deviceRate(rate, next, now))
    if (!(await this.env.ACCOUNTS.getByName(accountId).syndication())) return
    await sink.publish(accountId, { type: 'tokens-per-minute', at: new Date(now).toISOString(), ...accountRate(this.rates, now) })
  }
}
