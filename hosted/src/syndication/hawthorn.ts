import type { UsageEvent, UsageSink } from './sink.ts'

// The only hawthorn-specific code in this repository. When a deployment binds the
// HAWTHORN service (wrangler.jsonc), each opted-in account's tokens-per-minute
// event is passed over that service binding to hawthorn's TokenMonitorUsage
// entrypoint, addressed by the same Clerk user id that names the account here.
type TokenMonitorUsage = { publish(userId: string, event: UsageEvent): Promise<void> }

export function hawthornSink(service: TokenMonitorUsage): UsageSink {
  return { name: 'hawthorn', publish: (accountId, event) => service.publish(accountId, event) }
}
