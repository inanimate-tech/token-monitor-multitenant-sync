import { hawthornSink } from './hawthorn.ts'

// Everything that leaves this Worker for an external service goes through a
// UsageSink, and this event is the entire payload: no titles, projects, costs or
// device records.
export type UsageEvent = {
  type: 'tokens-per-minute'
  at: string
  tokensPerMinute: number
  devices: { deviceId: string; tokensPerMinute: number }[]
}

// `name` is shown to users on the opt-in, so they know where their data goes; the
// website links it to its source at syndication/<name>.ts.
export type UsageSink = { name: string; publish(accountId: string, event: UsageEvent): Promise<void> }

// No sink unless one is bound; a deployment without bindings sends nothing anywhere.
export function usageSink(env: Env): UsageSink | null {
  const { HAWTHORN } = env as { HAWTHORN?: Parameters<typeof hawthornSink>[0] }
  return HAWTHORN ? hawthornSink(HAWTHORN) : null
}
