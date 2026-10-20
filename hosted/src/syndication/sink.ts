import { WorkerEntrypoint } from 'cloudflare:workers'
import { hawthornSink } from './hawthorn.ts'

// Everything that passes between this Worker and an external service is here,
// and this event is the entire payload: no titles, projects, costs or device
// records.
export type UsageEvent = {
  type: 'tokens-per-minute'
  at: string
  tokensPerMinute: number
  devices: { deviceId: string; tokensPerMinute: number }[]
}

// `name` is shown to users, so they know where their data goes; the website links
// it to its source at syndication/<name>.ts. `publish` answers whether the account
// still has a subscriber; once it hasn't, nothing is published until the sink
// subscribes again.
export type UsageSink = { name: string; publish(accountId: string, event: UsageEvent): Promise<boolean> }

// No sink unless one is bound; a deployment without bindings sends nothing anywhere.
export function usageSink(env: Env): UsageSink | null {
  const { HAWTHORN } = env as { HAWTHORN?: Parameters<typeof hawthornSink>[0] }
  return HAWTHORN ? hawthornSink(HAWTHORN) : null
}

// The sink's way in, over a service binding: it subscribes to an account and gets
// the current event back. Nothing else, so it never reaches a Hub's data.
export class Subscriptions extends WorkerEntrypoint<Env> {
  subscribe(accountId: string): Promise<UsageEvent> {
    return this.env.HUB.getByName(accountId).subscribe()
  }
}
