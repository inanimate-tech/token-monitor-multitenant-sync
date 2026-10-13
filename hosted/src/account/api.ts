import { auth } from '@clerk/tanstack-react-start/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import { usageSink } from '../syndication/sink.ts'

// The account id is always the signed-in Clerk user, never taken from input.
async function account() {
  const { userId } = await auth()
  if (!userId) throw new Error('Not signed in')
  return { userId, stub: env.ACCOUNTS.getByName(userId) }
}

export const loadAccount = createServerFn().handler(async () => {
  if (!(await auth()).userId) return null
  const { stub } = await account()
  const sinkName = usageSink(env)?.name
  return {
    hubUrl: new URL(getRequest().url).origin,
    keys: await stub.listKeys(),
    // null when this deployment has no sink, so there is nothing to opt into.
    syndication: sinkName ? { sink: sinkName, enabled: await stub.syndication() } : null,
  }
})

export const createKey = createServerFn({ method: 'POST' })
  .validator((label: string) => String(label))
  .handler(async ({ data }) => {
    const { userId, stub } = await account()
    return (await stub.createKey(userId, data)).key
  })

export const revokeKey = createServerFn({ method: 'POST' })
  .validator((id: string) => String(id))
  .handler(async ({ data }) => (await account()).stub.revokeKey(data))

export const setSyndication = createServerFn({ method: 'POST' })
  .validator((enabled: boolean) => enabled === true)
  .handler(async ({ data }) => (await account()).stub.setSyndication(data))
